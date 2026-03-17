// content.js — injected into Greenhouse and Lever job pages
// Responsibilities:
//   1. Detect ATS type from URL
//   2. Scrape all form fields (labels, selectors, types, options) from live DOM
//   3. Listen for fill instructions from popup and inject values
//   4. Report page info back to popup on request

'use strict';

const ENGINE = 'http://127.0.0.1:38471';

const COVER_DEBUG_PREFIX = '[JobHunt:cover]';

function coverLog(step, payload) {
  const ts = new Date().toISOString();
  if (payload === undefined) {
    console.log(`${COVER_DEBUG_PREFIX} ${ts} ${step}`);
    return;
  }
  try {
    console.log(`${COVER_DEBUG_PREFIX} ${ts} ${step}`, payload);
  } catch {
    console.log(`${COVER_DEBUG_PREFIX} ${ts} ${step} ${String(payload)}`);
  }
}

function summarizeEl(el) {
  if (!el) return null;
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return {
    tag: el.tagName?.toLowerCase?.() || '',
    id: el.id || '',
    name: el.getAttribute?.('name') || '',
    type: el.getAttribute?.('type') || '',
    placeholder: el.getAttribute?.('placeholder') || '',
    role: el.getAttribute?.('role') || '',
    className: typeof el.className === 'string' ? el.className.slice(0, 160) : '',
    ariaLabel: el.getAttribute?.('aria-label') || '',
    visible: isVisible(el),
    selector: getSelector(el),
    text,
  };
}

function dumpVisibleTextareas() {
  return Array.from(document.querySelectorAll('textarea')).map(el => summarizeEl(el));
}

function dumpEnterManualButtons() {
  return Array.from(document.querySelectorAll('button, a'))
    .filter(el => (el.textContent || '').trim() === 'Enter manually')
    .map(el => {
      const container = el.closest('section, li, div, fieldset, form');
      return {
        ...summarizeEl(el),
        containerText: (container?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      };
    });
}


// ─── ATS detection ────────────────────────────────────────────────────────────

function detectATS() {
  const url = location.href.toLowerCase();
  if (url.includes('boards.greenhouse.io') || url.includes('job-boards.greenhouse.io')) {
    return 'greenhouse';
  }
  if (url.includes('jobs.lever.co')) {
    return 'lever';
  }
  return 'unknown';
}

function getJobTitle() {
  const selectors = [
    'h1.app-title',
    'h1[data-qa="job-title"]',
    '.posting-headline h2',
    'h1',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }
  return document.title;
}

function prettifyCompanySlug(slug) {
  if (!slug) return '';
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getCompany() {
  const selectors = [
    '.company-name',
    '[data-qa="company-name"]',
    '.main-header-text h2',
    '.posting-headline h3',
    '.posting-headline .company',
    '[data-qa="company"]',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }

  const host = location.hostname.toLowerCase();

  // Greenhouse hosted under job-boards.greenhouse.io/<company>/jobs/<id>
  if (host === 'job-boards.greenhouse.io') {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      return prettifyCompanySlug(parts[0]);
    }
  }

  // Older greenhouse subdomain style: <company>.greenhouse.io
  const subdomainMatch = location.hostname.match(/^([^.]+)\.greenhouse\.io$/i);
  if (subdomainMatch && subdomainMatch[1].toLowerCase() !== 'job-boards') {
    return prettifyCompanySlug(subdomainMatch[1]);
  }

  // Lever style: jobs.lever.co/<company>/<job>
  if (host === 'jobs.lever.co') {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      return prettifyCompanySlug(parts[0]);
    }
  }

  return '';
}

// ─── DOM scraper ──────────────────────────────────────────────────────────────

function getSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name.replace(/"/g, '\\"')}"]`;
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body) {
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (!parent) break;
    const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
    const idx = siblings.indexOf(cur) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    cur = parent;
  }
  return parts.join(' > ');
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}

function getLabel(el) {
  if (el.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl) return lbl.textContent.trim().replace(/\s*\*\s*$/, '').trim();
  }
  const parentLabel = el.closest('label');
  if (parentLabel) return parentLabel.textContent.trim().replace(/\s*\*\s*$/, '').trim();
  const container = el.closest('li, div.field, .application-question, [class*="field"], [class*="question"]');
  if (container) {
    const lbl = container.querySelector('label');
    if (lbl) return lbl.textContent.trim().replace(/\s*\*\s*$/, '').trim();
  }
  return el.placeholder || el.getAttribute('aria-label') || '';
}

async function scrapeFields() {
  // Click "Enter manually" buttons to expose textareas before scraping
  const enterBtns = Array.from(document.querySelectorAll('button, a'))
    .filter(btn => btn.textContent?.trim() === 'Enter manually' && isVisible(btn));

  if (enterBtns.length > 0) {
    for (const btn of enterBtns) {
      try {
        btn.click();
      } catch {}
    }

    // Give React time to mount the textareas
    const start = Date.now();
    while (Date.now() - start < 2500) {
      const resumeEl = document.querySelector('#resume_text');
      const coverEl = document.querySelector('#cover_letter_text');
      const anyVisibleTextarea = Array.from(document.querySelectorAll('textarea')).some(isVisible);

      if ((resumeEl && isVisible(resumeEl)) || (coverEl && isVisible(coverEl)) || anyVisibleTextarea) {
        break;
      }

      await new Promise(r => setTimeout(r, 80));
    }
  }

  const results = [];
  const seen = new Set();
  const noiseLabels = /^(enter manually|attach|upload|browse|choose file|accepted file types)$/i;

  const inputs = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"])' +
    ':not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="file"]),' +
    'select, textarea'
  );

  for (const el of inputs) {
    if (!isVisible(el)) continue;

    const selector = getSelector(el);
    if (seen.has(selector)) continue;
    seen.add(selector);

    const tag = el.tagName.toLowerCase();
    const type = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (el.type || 'text');
    let label = getLabel(el);

    // Force known Greenhouse manual-entry fields to proper names
    if (selector === '#cover_letter_text' || selector === '#cover_letter') {
      label = 'Cover Letter';
    }
    if (selector === '#resume_text') {
      label = 'Resume/CV';
    }

    if (!label || noiseLabels.test(label)) {
      if (selector === '#cover_letter_text' || selector === '#cover_letter') {
        results.push({
          selector,
          label: 'Cover Letter',
          type: 'textarea',
          required: false,
          options: [],
          value: '',
          isReactSelect: false,
        });
        continue;
      }

      if (selector === '#resume_text') {
        results.push({
          selector,
          label: 'Resume/CV',
          type: 'textarea',
          required: false,
          options: [],
          value: '',
          isReactSelect: false,
        });
        continue;
      }

      continue;
    }

    let options = [];
    if (tag === 'select') {
      options = Array.from(el.options)
        .filter(o => o.value !== '' && o.text.trim() !== 'Select...' && o.text.trim() !== '')
        .map(o => ({ value: o.value, label: o.text.trim() }));
    }

    const required =
      el.required ||
      !!el.closest('[class*="required"], [aria-required="true"]') ||
      !!el.closest('li, div.field')?.textContent?.includes('*');

    results.push({
      selector,
      label,
      type,
      required,
      options,
      value: '',
      isReactSelect: false,
    });
  }

  document.querySelectorAll('[role="combobox"], [class*="select__control"]').forEach(ctrl => {
    if (!isVisible(ctrl)) return;
    const container = ctrl.closest('li, div.field, .application-question, [class*="field"], [class*="eeoc"]');
    if (!container) return;

    const lbl = container.querySelector('label');
    const label = lbl
      ? lbl.textContent.trim().replace(/\s*\*\s*$/, '').trim()
      : container.textContent.trim().split('\n')[0].trim().replace(/\s*\*\s*$/, '');

    if (!label || noiseLabels.test(label)) return;

    const selector = getSelector(ctrl);
    if (seen.has(selector)) return;
    seen.add(selector);

    const required =
      !!container.querySelector('[class*="required"], .asterisk') ||
      container.textContent.includes('*');

    results.push({
      selector,
      label,
      type: 'react-select',
      required,
      options: [],
      value: '',
      isReactSelect: true,
    });
  });

  return results.filter(f => f.label.length < 300);
}

// Hydrate React select options by clicking each one
async function hydrateReactSelectOptions(fields) {
  for (const field of fields) {
    if (field.type !== 'react-select') continue;
    try {
      const ctrl = document.querySelector(field.selector);
      if (!ctrl) continue;
      ctrl.click();
      await new Promise(r => setTimeout(r, 350));
      const opts = Array.from(document.querySelectorAll('[role="option"], [class*="select__option"]'))
        .filter(el => el.getBoundingClientRect().height > 0)
        .map(el => ({ value: el.getAttribute('data-value') || el.textContent.trim(), label: el.textContent.trim() }))
        .filter(o => o.label && o.label !== 'Select...');
      if (opts.length > 0) field.options = opts;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
    } catch {}
  }
  return fields;
}

// ─── Field injection ──────────────────────────────────────────────────────────

// Fill a single textarea or input using React-safe native setter
function fillTextEl(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Wait for an element matching any of the selectors to become visible.
// Polls all selectors in parallel every 80ms — first match wins.
// Also watches for any newly-appeared textarea as a last resort.
async function waitForAnyVisible(selectors, maxMs = 2500) {
  const start = Date.now();
  const before = new Set(Array.from(document.querySelectorAll('textarea')));

  while (Date.now() - start < maxMs) {
    // Prefer explicit selectors, but only if they resolve to a non-file visible textarea/input
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (!isVisible(el)) continue;

        const tag = el.tagName?.toLowerCase();
        const type = (el.getAttribute?.("type") || "").toLowerCase();

        // Never allow file inputs here
        if (tag === "input" && type === "file") continue;

        // Cover/manual-entry should really be textarea-based
        if (tag === "textarea") return el;
      } catch {}
    }

    // Fallback: any newly appeared visible textarea
    for (const el of document.querySelectorAll("textarea")) {
      if (!before.has(el) && isVisible(el)) return el;
    }

    await new Promise((r) => setTimeout(r, 80));
  }

  return null;
}

async function injectFields(filledFields) {
  let filled = 0;
  coverLog('inject.start', {
    url: location.href,
    totalFields: filledFields.length,
    filledValueCount: filledFields.filter(f => !!f.value).length,
    coverCandidates: filledFields.filter(f =>
      (f.label || '').toLowerCase().includes('cover') ||
      (f.label || '').toLowerCase().includes('letter') ||
      f.selector === '#cover_letter_text' ||
      f.selector === '#cover_letter'
    ).map(f => ({
      label: f.label,
      selector: f.selector,
      type: f.type,
      valueLength: f.value?.length || 0,
    })),
  });

  // ── Cover letter: dedicated robust handler ──────────────────────────────────
  // Greenhouse hides the textarea behind "Enter manually". We must:
  //   1. Find and click the correct "Enter manually" button (the one for cover letter,
  //      not the resume one — there may be two on the page)
  //   2. Wait for the textarea to actually appear in the DOM and become visible
  //   3. Fill it with React-safe native setter + dispatch events
  const coverField = filledFields.find(f =>
    f.value && (
      (f.label || '').toLowerCase().includes('cover') ||
      (f.label || '').toLowerCase().includes('letter') ||
      f.selector === '#cover_letter_text' ||
      f.selector === '#cover_letter'
    )
  );

  if (coverField?.value) {
    coverLog('inject.coverField.found', {
      label: coverField.label,
      selector: coverField.selector,
      type: coverField.type,
      valueLength: coverField.value.length,
      preview: coverField.value.slice(0, 120),
    });

    const beforeTextareas = new Set(Array.from(document.querySelectorAll('textarea')));
    coverLog('inject.beforeClick', {
      textareas: dumpVisibleTextareas(),
      enterButtons: dumpEnterManualButtons(),
    });

    const allBtns = Array.from(document.querySelectorAll('button, a'));
    const enterBtns = allBtns.filter(b => b.textContent?.trim() === 'Enter manually' && isVisible(b));
    coverLog('inject.enterButtons.visible', enterBtns.map(btn => {
      const container = btn.closest('section, .field, li, div, fieldset, form');
      return {
        button: summarizeEl(btn),
        containerText: (container?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      };
    }));

    if (enterBtns.length > 0) {
      let clicked = false;
      for (const btn of enterBtns) {
        const container = btn.closest('section, .field, li, div, fieldset, form');
        const txt = container?.textContent?.toLowerCase() || '';
        const shouldClick = txt.includes('cover') || txt.includes('letter') || enterBtns.length === 1;
        coverLog('inject.enterButton.consider', {
          button: summarizeEl(btn),
          shouldClick,
          containerText: txt.slice(0, 220),
        });
        if (shouldClick) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          coverLog('inject.enterButton.clicked', summarizeEl(btn));
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        enterBtns.forEach(b => b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
        coverLog('inject.enterButton.clickedFallbackAll', enterBtns.map(summarizeEl));
      }
    } else {
      coverLog('inject.enterButtons.noneVisible');
    }

    await new Promise(r => setTimeout(r, 500));
    coverLog('inject.afterClick', {
      textareas: dumpVisibleTextareas(),
      enterButtons: dumpEnterManualButtons(),
    });

    const coverSelectors = [
      coverField.selector,
      '#cover_letter_text',
      'textarea[name*="cover" i]',
      'textarea[placeholder*="cover" i]',
      'textarea[placeholder*="letter" i]',
      'textarea[id*="cover" i]',
      'textarea[aria-label*="cover" i]',
      'textarea',
    ];

    const coverEl = await waitForAnyVisible(coverSelectors, 5000, beforeTextareas);
    if (coverEl) {
      const tag = coverEl.tagName?.toLowerCase();
      const type = (coverEl.getAttribute?.("type") || "").toLowerCase();

      coverLog('inject.coverEl.found', {
        ...summarizeEl(coverEl),
        tag,
        type,
      });

      if (tag === 'input' && type === 'file') {
        coverLog('inject.coverEl.rejectedFileInput', {
          reason: 'resolved cover target was a file input, refusing to write text into it',
          selectorTried: coverField.selector,
          chosenEl: summarizeEl(coverEl),
          coverSelectors,
        });
      } else {
        coverEl.focus();
        fillTextEl(coverEl, coverField.value);
        coverEl.dispatchEvent(new Event('blur', { bubbles: true }));
        filled++;

        coverLog('inject.coverEl.filled', {
          finalValueLength: coverEl.value?.length || 0,
          matchesExpected: (coverEl.value || '') === coverField.value,
          preview: (coverEl.value || '').slice(0, 120),
        });
      }
    } else {
      coverLog('inject.coverEl.notFound', {
        coverSelectors,
        textareas: dumpVisibleTextareas(),
        allCoverish: Array.from(document.querySelectorAll('[id*="cover" i], [name*="cover" i], [class*="cover" i], textarea'))
          .slice(0, 20)
          .map(summarizeEl),
      });
    }
  } else if (filledFields.find(f => (f.label || '').toLowerCase().includes('cover'))) {
    coverLog('inject.coverField.missingValue', filledFields
      .filter(f => (f.label || '').toLowerCase().includes('cover') || (f.label || '').toLowerCase().includes('letter'))
      .map(f => ({ label: f.label, selector: f.selector, valueLength: f.value?.length || 0 })));
  } else {
    coverLog('inject.coverField.notPresent');
  }

  // ── All other fields ────────────────────────────────────────────────────────
  for (const field of filledFields) {
    if (!field.value) continue;

    // Skip cover letter — handled above
    const isCover =
      (field.label || '').toLowerCase().includes('cover') ||
      (field.label || '').toLowerCase().includes('letter') ||
      field.selector === '#cover_letter_text' ||
      field.selector === '#cover_letter';
    if (isCover) continue;

    try {
      const el = document.querySelector(field.selector);
      if (!el || !isVisible(el)) continue;
      
      const tag = el.tagName?.toLowerCase();
      const type = (el.getAttribute?.("type") || "").toLowerCase();
      if (tag === 'input' && type === 'file') continue;

      if (field.isReactSelect || field.type === 'react-select') {
        el.click();
        await new Promise(r => setTimeout(r, 350));
        const opts = document.querySelectorAll('[role="option"], [class*="select__option"]');
        let matched = false;
        for (const opt of opts) {
          if (opt.textContent.trim().toLowerCase() === field.value.toLowerCase()) {
            opt.click();
            matched = true;
            filled++;
            break;
          }
        }
        if (!matched) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      } else if (field.type === 'select') {
        const opt = Array.from(el.options).find(
          o => o.text.toLowerCase() === field.value.toLowerCase() ||
               o.value.toLowerCase() === field.value.toLowerCase()
        );
        if (opt) {
          el.value = opt.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }

      } else {
        fillTextEl(el, field.value);
        filled++;
      }
    } catch {}
  }

  coverLog('inject.finish', { filledCount: filled });
  return filled;
}

// ─── Message handler ──────────────────────────────────────────────────────────

// ─── Floating button ──────────────────────────────────────────────────────────
// Injected directly onto Greenhouse/Lever pages so users don't need to click
// the toolbar icon. Chrome cannot auto-open a popup programmatically.

function injectFloatingButton() {
  if (document.getElementById('jh-float-btn')) return; // already injected

  const btn = document.createElement('button');
  btn.id = 'jh-float-btn';
  btn.innerHTML = '⚡ JobHunt';
  btn.title = 'Auto Apply with JobHunt';
  Object.assign(btn.style, {
    position:     'fixed',
    top:          '16px',
    right:        '16px',
    zIndex:       '2147483647',
    padding:      '10px 20px',
    background:   '#0a84ff',
    color:        'white',
    border:       'none',
    borderRadius: '999px',
    fontSize:     '13px',
    fontWeight:   '700',
    fontFamily:   'ui-sans-serif, system-ui, -apple-system, sans-serif',
    cursor:       'pointer',
    boxShadow:    '0 4px 20px rgba(10,132,255,0.45)',
    transition:   'transform 120ms ease, box-shadow 120ms ease',
    letterSpacing:'-0.01em',
  });

  btn.addEventListener('mouseenter', () => {
    btn.style.transform  = 'translateY(-2px)';
    btn.style.boxShadow  = '0 6px 26px rgba(10,132,255,0.6)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.transform  = '';
    btn.style.boxShadow  = '0 4px 20px rgba(10,132,255,0.45)';
  });

  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FLOAT_BTN_CLICKED' });
  });

  document.body.appendChild(btn);
}

// Set button state from popup messages
function setFloatState(state, msg) {
  const btn = document.getElementById('jh-float-btn');
  if (!btn) return;
  if (state === 'working') {
    btn.innerHTML = '⏳ ' + (msg || 'Working…');
    btn.style.background = 'rgba(255,199,0,0.9)';
    btn.style.color = '#000';
    btn.disabled = true;
  } else if (state === 'done') {
    btn.innerHTML = '✓ ' + (msg || 'Filled');
    btn.style.background = 'rgba(30,215,96,0.9)';
    btn.style.color = '#000';
    btn.disabled = false;
    setTimeout(() => {
      btn.innerHTML = '⚡ JobHunt';
      btn.style.background = '#0a84ff';
      btn.style.color = 'white';
    }, 3000);
  } else if (state === 'error') {
    btn.innerHTML = '✗ ' + (msg || 'Error');
    btn.style.background = 'rgba(255,69,58,0.9)';
    btn.style.color = 'white';
    btn.disabled = false;
    setTimeout(() => {
      btn.innerHTML = '⚡ JobHunt';
      btn.style.background = '#0a84ff';
      btn.style.color = 'white';
    }, 3000);
  } else {
    btn.innerHTML = '⚡ JobHunt';
    btn.style.background = '#0a84ff';
    btn.style.color = 'white';
    btn.disabled = false;
  }
}

// Inject button when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectFloatingButton);
} else {
  injectFloatingButton();
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_INFO') {
    sendResponse({
      url: location.href,
      ats: detectATS(),
      title: getJobTitle(),
      company: getCompany(),
    });
    return false;
  }

  if (msg.type === 'SCRAPE_FIELDS') {
    (async () => {
      try {
        coverLog('message.SCRAPE_FIELDS.start', { url: location.href });
        let fields = await scrapeFields();
        fields = await hydrateReactSelectOptions(fields);
        coverLog('message.SCRAPE_FIELDS.done', {
          totalFields: fields.length,
          coverFields: fields.filter(f =>
            ((f.label || '').toLowerCase().includes('cover')) ||
            ((f.label || '').toLowerCase().includes('letter')) ||
            f.selector === '#cover_letter_text' ||
            f.selector === '#cover_letter'
          ),
        });
        sendResponse({ fields });
      } catch (err) {
        const message = String(err?.message || err);
        coverLog('message.SCRAPE_FIELDS.error', { message, stack: err?.stack || '' });
        sendResponse({ error: message, fields: [] });
      }
    })();
    return true;
  }

  if (msg.type === 'INJECT_FIELDS') {
    (async () => {
      try {
        coverLog('message.INJECT_FIELDS.start', {
          totalFields: msg.fields?.length || 0,
          coverFields: (msg.fields || []).filter(f =>
            ((f.label || '').toLowerCase().includes('cover')) ||
            ((f.label || '').toLowerCase().includes('letter')) ||
            f.selector === '#cover_letter_text' ||
            f.selector === '#cover_letter'
          ).map(f => ({
            label: f.label,
            selector: f.selector,
            valueLength: f.value?.length || 0,
          })),
        });

        const count = await injectFields(msg.fields || []);
        coverLog('message.INJECT_FIELDS.done', { filled: count });
        sendResponse({ filled: count });
      } catch (err) {
        const message = String(err?.message || err);
        coverLog('message.INJECT_FIELDS.error', { message, stack: err?.stack || '' });
        sendResponse({ error: message, filled: 0 });
      }
    })();
    return true;
  }

  if (msg.type === 'SET_FLOAT_STATE') {
    setFloatState(msg.state, msg.msg);
    sendResponse({});
    return false;
  }
});