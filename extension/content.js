// content.js — injected into Greenhouse and Lever job pages
// Responsibilities:
//   1. Detect ATS type from URL
//   2. Scrape all form fields (labels, selectors, types, options) from live DOM
//   3. Listen for fill instructions from popup and inject values
//   4. Report page info back to popup on request

'use strict';

const ENGINE = 'http://127.0.0.1:38471';

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

function getCompany() {
  const selectors = [
    '.company-name',
    '[data-qa="company-name"]',
    '.main-header-text h2',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }
  // Fall back to subdomain or path segment
  const match = location.hostname.match(/^([^.]+)\.greenhouse/);
  if (match) return match[1];
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

function scrapeFields() {
  // Click "Enter manually" buttons to expose textareas before scraping
  document.querySelectorAll('button, a').forEach(btn => {
    if (btn.textContent?.trim() === 'Enter manually' && isVisible(btn)) {
      btn.click();
    }
  });

  const results = [];
  const seen = new Set();
  const noiseLabels = /^(enter manually|attach|upload|browse|choose file|accepted file types)/i;

  // Standard inputs/selects/textareas
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

    const tag  = el.tagName.toLowerCase();
    const type = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (el.type || 'text');
    const label = getLabel(el);

    if (!label || noiseLabels.test(label)) {
      // Rename known cover letter / resume selectors even if label is noise
      if (selector === '#cover_letter_text' || selector === '#cover_letter') {
        results.push({ selector, label: 'Cover Letter', type: 'textarea', required: false, options: [], value: '' });
        continue;
      }
      if (selector === '#resume_text') continue; // skip resume text box
      if (!label) continue;
    }

    let options = [];
    if (tag === 'select') {
      options = Array.from(el.options)
        .filter(o => o.value !== '' && o.text.trim() !== 'Select...' && o.text.trim() !== '')
        .map(o => ({ value: o.value, label: o.text.trim() }));
    }

    const required = el.required ||
      !!el.closest('[class*="required"], [aria-required="true"]') ||
      !!el.closest('li, div.field')?.textContent.includes('*');

    results.push({ selector, label, type, required, options, value: '', isReactSelect: false });
  }

  // React custom selects (Greenhouse EEO widgets)
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
    const required = !!container.querySelector('[class*="required"], .asterisk') ||
      container.textContent.includes('*');
    results.push({ selector, label, type: 'react-select', required, options: [], value: '', isReactSelect: true });
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

async function injectFields(filledFields) {
  let filled = 0;

  // Cover letter — click Enter manually first
  const coverField = filledFields.find(f =>
    f.value && (f.label.toLowerCase().includes('cover') ||
    f.selector === '#cover_letter_text' || f.selector === '#cover_letter')
  );
  if (coverField?.value) {
    document.querySelectorAll('button, a').forEach(btn => {
      if (btn.textContent?.trim() === 'Enter manually' && isVisible(btn)) btn.click();
    });
    await new Promise(r => setTimeout(r, 400));
  }

  for (const field of filledFields) {
    if (!field.value) continue;
    try {
      const el = document.querySelector(field.selector);
      if (!el || !isVisible(el)) continue;

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
        const select = el;
        const opt = Array.from(select.options).find(
          o => o.text.toLowerCase() === field.value.toLowerCase() ||
               o.value.toLowerCase() === field.value.toLowerCase()
        );
        if (opt) {
          select.value = opt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }
      } else {
        // text / textarea / email / tel
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
          'value'
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, field.value);
        } else {
          el.value = field.value;
        }
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
      }
    } catch {}
  }
  return filled;
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_INFO') {
    sendResponse({
      url:     location.href,
      ats:     detectATS(),
      title:   getJobTitle(),
      company: getCompany(),
    });
    return false;
  }

  if (msg.type === 'SCRAPE_FIELDS') {
    (async () => {
      let fields = scrapeFields();
      fields = await hydrateReactSelectOptions(fields);
      sendResponse({ fields });
    })();
    return true; // async
  }

  if (msg.type === 'INJECT_FIELDS') {
    (async () => {
      const count = await injectFields(msg.fields);
      sendResponse({ filled: count });
    })();
    return true; // async
  }
});