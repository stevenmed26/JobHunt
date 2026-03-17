#!/usr/bin/env node
/**
 * jobhunt-filler — two-mode Playwright ATS filler
 *
 * SCRAPE mode:  node filler.js --scrape --url <url> --out <result.json>
 *   Opens the form, reads every visible field, writes structured JSON, exits.
 *
 * FILL mode:    node filler.js --fill --job <job.json>
 *   Opens the form, injects pre-filled values using exact selectors, stays open.
 *
 * scrape result shape (written to --out file):
 * {
 *   "url": "...",
 *   "fields": [
 *     {
 *       "selector":  "#first_name",          // unique CSS selector
 *       "label":     "First Name",            // human-readable label
 *       "type":      "text",                  // text|email|tel|select|textarea|file
 *       "required":  true,
 *       "options":   [],                      // non-empty for <select>
 *       "value":     ""                       // pre-filled by engine before review
 *     }
 *   ]
 * }
 *
 * fill job.json shape:
 * {
 *   "url": "...",
 *   "fields": [
 *     { "selector": "#first_name", "value": "Jane", "type": "text",   "isFile": false },
 *     { "selector": "#resume",     "value": "/path/resume.pdf", "type": "file", "isFile": true }
 *   ]
 * }
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── CLI parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const mode = args.includes('--scrape') ? 'scrape' : args.includes('--fill') ? 'fill' : null;

if (!mode) {
  console.error('[filler] Usage:');
  console.error('  node filler.js --scrape --url <url> --out <result.json>');
  console.error('  node filler.js --fill   --job <job.json>');
  process.exit(1);
}

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

function log(msg) { console.log(`[filler:${mode}] ${msg}`); }

function short(str, n = 160) {
  return String(str ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

async function snapshotCoverDom(page, tag = 'snapshot') {
  try {
    const data = await page.evaluate((tagName) => {
      function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      function summarize(el) {
        if (!el) return null;
        return {
          tag: el.tagName?.toLowerCase?.() || '',
          id: el.id || '',
          name: el.getAttribute?.('name') || '',
          placeholder: el.getAttribute?.('placeholder') || '',
          role: el.getAttribute?.('role') || '',
          className: typeof el.className === 'string' ? el.className.slice(0, 160) : '',
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          visible: isVisible(el),
        };
      }

      return {
        tag: tagName,
        url: location.href,
        title: document.title,
        textareas: Array.from(document.querySelectorAll('textarea')).map(summarize),
        enterManualButtons: Array.from(document.querySelectorAll('button, a'))
          .filter(el => (el.textContent || '').trim() === 'Enter manually')
          .map(el => {
            const container = el.closest('section, li, div, fieldset, form');
            return {
              button: summarize(el),
              containerText: (container?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
            };
          }),
        coverishNodes: Array.from(document.querySelectorAll('[id*="cover" i], [name*="cover" i], [class*="cover" i], [placeholder*="cover" i]'))
          .slice(0, 20)
          .map(summarize),
      };
    }, tag);
    log(`DEBUG: cover DOM ${tag}: ${JSON.stringify(data)}`);
  } catch (e) {
    log(`WARN: snapshotCoverDom(${tag}) failed: ${e.message}`);
  }
}



// ─── SCRAPE MODE ──────────────────────────────────────────────────────────────

async function runScrape() {
  const url    = getArg('--url');
  const outFile = getArg('--out');

  if (!url || !outFile) {
    console.error('[filler] --scrape requires --url and --out');
    process.exit(1);
  }

  log(`Opening: ${url}`);

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] }); // visible to avoid bot detection
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500); // let React render

    // Click "Enter manually" for cover letter to expose the textarea before scraping
    const enterManuallyBtns = await page.locator('button:has-text("Enter manually"), a:has-text("Enter manually")').all();
    for (const btn of enterManuallyBtns) {
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(400);
        log('  clicked "Enter manually" to expose textarea');
      }
    }

    const fields = await page.evaluate(() => {
      const results = [];
      const seen    = new Set();

      // Generate a unique, stable CSS selector for an element
      function getSelector(el) {
        if (el.id) return `#${CSS.escape(el.id)}`;

        // name attribute
        if (el.name) {
          const tag = el.tagName.toLowerCase();
          return `${tag}[name="${el.name.replace(/"/g, '\\"')}"]`;
        }

        // Build a path of nth-of-type selectors
        const parts = [];
        let cur = el;
        while (cur && cur !== document.body) {
          const tag    = cur.tagName.toLowerCase();
          const parent = cur.parentElement;
          if (!parent) break;
          const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
          const idx      = siblings.indexOf(cur) + 1;
          parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
          cur = parent;
        }
        return parts.join(' > ');
      }

      // Determine if an element is visible to the user
      function isVisible(el) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      // Extract label text for an input
      function getLabel(el) {
        // Explicit <label for="id">
        if (el.id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) return lbl.textContent.trim().replace(/\s*\*\s*$/, '').trim();
        }
        // Wrapping <label>
        const parentLabel = el.closest('label');
        if (parentLabel) return parentLabel.textContent.trim().replace(/\s*\*\s*$/, '').trim();

        // Closest container with a <label>
        const container = el.closest('li, div.field, .application-question, [class*="field"], [class*="question"]');
        if (container) {
          const lbl = container.querySelector('label');
          if (lbl) return lbl.textContent.trim().replace(/\s*\*\s*$/, '').trim();
          // Fallback: first meaningful text node in the container
          const text = container.textContent.trim().split('\n')[0].trim().replace(/\s*\*\s*$/, '');
          if (text.length > 2 && text.length < 200) return text;
        }

        // placeholder
        if (el.placeholder) return el.placeholder;
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        return '';
      }

      function isRequired(el) {
        if (el.required) return true;
        const container = el.closest('li, div.field, .application-question, [class*="field"]');
        if (container) return !!container.querySelector('[class*="required"], .asterisk, [aria-required="true"]')
          || container.textContent.includes('*');
        return false;
      }

      // ── Collect all input/select/textarea elements ──────────────────────────

      const inputs = Array.from(document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="file"]), ' +
        'select, textarea'
      ));

      for (const el of inputs) {
        if (!isVisible(el)) continue;

        const selector = getSelector(el);
        if (seen.has(selector)) continue;
        seen.add(selector);

        const tag     = el.tagName.toLowerCase();
        const type    = tag === 'select' ? 'select'
                       : tag === 'textarea' ? 'textarea'
                       : (el.type || 'text');
        const label   = getLabel(el);
        const required = isRequired(el);

        let options = [];
        if (tag === 'select') {
          options = Array.from(el.options)
            .filter(o => o.value !== '' && o.text.trim() !== 'Select...' && o.text.trim() !== '')
            .map(o => ({ value: o.value, label: o.text.trim() }));
        }

        results.push({ selector, label, type, required, options, value: '' });
      }

      // ── Also detect Greenhouse/Lever React custom select widgets ────────────
      // These render a visible div but the actual <select> is hidden.
      // We identify them by their aria roles and include them separately.

      const reactSelects = Array.from(document.querySelectorAll(
        '[role="combobox"], [class*="select__control"], [class*="SelectControl"]'
      ));

      for (const ctrl of reactSelects) {
        if (!isVisible(ctrl)) continue;

        const container = ctrl.closest('li, div.field, .application-question, [class*="field"], [class*="eeoc"]');
        if (!container) continue;

        const label = (() => {
          const lbl = container.querySelector('label');
          if (lbl) return lbl.textContent.trim().replace(/\s*\*\s*$/, '').trim();
          return container.textContent.trim().split('\n')[0].trim().replace(/\s*\*\s*$/, '');
        })();

        if (!label) continue;

        // Build a selector for this control
        const selector = getSelector(ctrl);
        if (seen.has(selector)) continue;
        seen.add(selector);

        // Peek at available options by briefly checking aria-owns or sibling listbox
        const listboxId = ctrl.getAttribute('aria-owns') || ctrl.getAttribute('aria-controls');
        let options = [];
        if (listboxId) {
          const listbox = document.getElementById(listboxId);
          if (listbox) {
            options = Array.from(listbox.querySelectorAll('[role="option"]'))
              .map(o => ({ value: o.getAttribute('data-value') || o.textContent.trim(), label: o.textContent.trim() }))
              .filter(o => o.label);
          }
        }

        const required = !!container.querySelector('[class*="required"], .asterisk')
          || container.textContent.includes('*');

        results.push({
          selector,
          label,
          type: 'react-select',
          required,
          options,
          value: '',
          isReactSelect: true,
        });
      }

      return results;
    });

    // Filter noise
    const cleaned = fields.filter(f =>
      f.label.length > 0 &&
      f.label.length < 300 &&
      !f.label.match(/^(search|filter|sort)/i)
    );

    log(`Found ${cleaned.length} fields — hydrating React select options...`);

    // ── Hydrate React select options by clicking each one ────────────────────
    // Greenhouse renders options lazily — they only appear in the DOM after
    // the control is clicked. We click each react-select, read the option list,
    // then close it before moving to the next.
    for (const field of cleaned) {
      if (field.type !== 'react-select') continue;
      try {
        const ctrl = page.locator(field.selector).first();
        if (await ctrl.count() === 0) continue;

        // Click to open
        await ctrl.click();
        await page.waitForTimeout(400);

        // Read all visible options from the open dropdown
        const options = await page.evaluate(() => {
          const optEls = Array.from(document.querySelectorAll(
            '[role="option"], [class*="select__option"], [class*="SelectOption"], [class*="option--"]'
          ));
          return optEls
            .filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            })
            .map(el => ({
              value: el.getAttribute('data-value') || el.textContent.trim(),
              label: el.textContent.trim(),
            }))
            .filter(o => o.label && o.label !== 'Select...' && o.label !== '');
        });

        if (options.length > 0) {
          field.options = options;
          log(`  "${field.label}" -> ${options.length} options`);
        }

        // Close the dropdown without selecting anything
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
      } catch (e) {
        // If clicking fails just leave options empty — still usable as free-text
        log(`  WARN: could not hydrate "${field.label}": ${e.message}`);
        await page.keyboard.press('Escape').catch(() => null);
      }
    }

    log(`Scrape complete — ${cleaned.length} fields ready`);

    const result = { url, fields: cleaned };
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    log(`Wrote ${outFile}`);

  } catch (err) {
    console.error('[filler] Scrape error:', err.message);
    fs.writeFileSync(outFile, JSON.stringify({ url, fields: [], error: err.message }), 'utf8');
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── FILL MODE ────────────────────────────────────────────────────────────────

async function runFill() {
  const jobFile = getArg('--job');
  if (!jobFile || !fs.existsSync(jobFile)) {
    console.error('[filler] --fill requires --job <path>');
    process.exit(1);
  }

  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  log(`Opening: ${job.url}`);
  log(`Fields to fill: ${job.fields.length}`);

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null, acceptDownloads: true });
  const page    = await context.newPage();

  page.on('dialog', async d => { await d.dismiss().catch(() => null); });
  page.on('console', msg => {
    log(`PAGE CONSOLE [${msg.type()}]: ${msg.text()}`);
  });
  page.on('pageerror', err => {
    log(`PAGE ERROR: ${err.message}`);
  });

  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    log('Starting fill...');

    // ── Pre-fill: handle Greenhouse special widgets before main loop ───────────

    // Cover letter — extra verbose debug version
    const coverField = job.fields.find(f =>
      f.value &&
      (
        f.label.toLowerCase().includes('cover') ||
        f.label.toLowerCase().includes('letter') ||
        f.selector === '#cover_letter_text' ||
        f.selector === '#cover_letter'
      )
    );

    log(`DEBUG: cover field found: ${!!coverField}`);
    if (coverField) {
      log(`DEBUG: cover label="${coverField.label}" selector="${coverField.selector}" type="${coverField.type}" value_len=${coverField.value?.length}`);
      log(`DEBUG: cover preview="${short(coverField.value, 200)}"`);
    }

    if (coverField && coverField.value) {
      try {
        await snapshotCoverDom(page, 'before-cover-click');

        const enterBtns = await page.locator(
          'button:has-text("Enter manually"), a:has-text("Enter manually"), [data-source="paste"]'
        ).all();

        log(`DEBUG: "Enter manually" buttons found: ${enterBtns.length}`);

        let clicked = false;
        for (const btn of enterBtns) {
          const vis = await btn.isVisible().catch(() => false);
          const txt = short(await btn.textContent().catch(() => ''));
          const containerText = short(await btn.evaluate(el => {
            const container = el.closest('section, li, div, fieldset, form');
            return container?.textContent || '';
          }).catch(() => ''));
          log(`DEBUG: Enter manually candidate visible=${vis} text="${txt}" container="${containerText}"`);
          if (!vis) continue;
          const shouldClick = containerText.toLowerCase().includes('cover') || containerText.toLowerCase().includes('letter') || enterBtns.length === 1;
          if (shouldClick) {
            await btn.click({ force: true }).catch(async () => {
              await btn.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
            });
            clicked = true;
            log(`DEBUG: clicked Enter manually target text="${txt}"`);
            break;
          }
        }

        if (!clicked && enterBtns.length > 0) {
          log('DEBUG: no clearly cover-related Enter manually button found, clicking all as fallback');
          for (const btn of enterBtns) {
            const vis = await btn.isVisible().catch(() => false);
            if (!vis) continue;
            await btn.click({ force: true }).catch(async () => {
              await btn.evaluate(el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
            });
          }
        }

        await page.waitForTimeout(900);
        await snapshotCoverDom(page, 'after-cover-click');

        let coverLoc = null;

        if (coverField.selector) {
          const exact = page.locator(coverField.selector).first();
          const cnt = await exact.count();
          const vis = cnt > 0 && await exact.isVisible().catch(() => false);
          log(`DEBUG: exact selector "${coverField.selector}" count=${cnt} visible=${vis}`);
          if (vis) coverLoc = exact;
        }

        if (!coverLoc) {
          const fallbacks = [
            '#cover_letter_text',
            '#cover_letter',
            'textarea[name*="cover" i]',
            'textarea[id*="cover" i]',
            'textarea[placeholder*="cover" i]',
            'textarea[placeholder*="letter" i]',
            'textarea[aria-label*="cover" i]',
            'textarea[class*="cover" i]',
          ];
          for (const sel of fallbacks) {
            const l = page.locator(sel).first();
            const cnt = await l.count();
            const vis = cnt > 0 && await l.isVisible().catch(() => false);
            log(`DEBUG: fallback "${sel}" count=${cnt} visible=${vis}`);
            if (vis) {
              coverLoc = l;
              break;
            }
          }
        }

        if (!coverLoc) {
          const visTextareas = await page.locator('textarea:visible').all();
          log(`DEBUG: visible textareas for last resort: ${visTextareas.length}`);
          if (visTextareas.length > 0) {
            coverLoc = visTextareas[visTextareas.length - 1];
            log('DEBUG: using last visible textarea as last resort');
          }
        }

        if (coverLoc) {
          await coverLoc.focus().catch(() => null);
          await coverLoc.evaluate((el, value) => {
            const proto = el.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
          }, coverField.value);

          const finalValue = await coverLoc.inputValue().catch(() => '');
          log(`cover letter: filled final_len=${finalValue.length} exact_match=${finalValue === coverField.value}`);
          log(`cover letter: final preview="${short(finalValue, 200)}"`);
        } else {
          log('WARN: cover letter textarea not found after all attempts');
          const html = await page.evaluate(() => {
            const el = document.querySelector('[class*="cover"], [id*="cover"], [data-field*="cover"]');
            return el ? el.outerHTML.substring(0, 1200) : '(no cover element found)';
          });
          log(`DEBUG: cover area HTML: ${html}`);
          await snapshotCoverDom(page, 'cover-not-found');
        }
      } catch (e) {
        log(`WARN: cover letter failed: ${e.message}
${e.stack}`);
        await snapshotCoverDom(page, 'cover-exception').catch(() => null);
      }
    } else {
      log('DEBUG: no cover field with value was present in fill payload');
    }

    // ── Main field loop ────────────────────────────────────────────────────────

    let filled = 0, skipped = 0;

    for (const field of job.fields) {
      // Skip cover letter — handled in pre-fill above
      if (field.value && (field.label.toLowerCase().includes('cover') || field.label.toLowerCase().includes('letter'))) {
        skipped++; continue;
      }
      // Skip file fields entirely — user uploads resume manually
      if (field.isFile || field.type === 'file') { skipped++; continue; }
      if (!field.value && !field.isFile) { skipped++; continue; }

      try {
        const result = await fillField(page, field);
        if (result) filled++;
        else skipped++;
      } catch (e) {
        log(`WARN: ${field.label} (${field.selector}): ${e.message}`);
        skipped++;
      }
    }

    log(`Fill complete: ${filled} filled, ${skipped} skipped.`);
    log('Review the form, solve any CAPTCHA, then click Submit.');

    await new Promise(resolve => {
      browser.on('disconnected', resolve);
      context.on('close', resolve);
    });

  } catch (err) {
    console.error('[filler] Fill error:', err.message);
    await new Promise(r => setTimeout(r, 60000));
    await browser.close();
    process.exit(1);
  }

  process.exit(0);
}

async function fillField(page, field) {
  const { selector, value, type, isFile, isReactSelect } = field;

  // Try the exact selector first
  let loc = page.locator(selector).first();
  let found = await loc.count() > 0 && await loc.isVisible().catch(() => false);

  // If exact selector fails (page re-rendered), fall back to label search
  if (!found && field.label) {
    const escaped = field.label.replace(/"/g, '\\"').replace(/'/g, "\\'");
    const fallbacks = [
      `label:has-text("${escaped}") + input`,
      `label:has-text("${escaped}") + select`,
      `label:has-text("${escaped}") + textarea`,
      `label:has-text("${escaped}") ~ * > input`,
      `label:has-text("${escaped}") ~ * > select`,
      `label:has-text("${escaped}") ~ * > textarea`,
    ];
    for (const fb of fallbacks) {
      const l = page.locator(fb).first();
      if (await l.count() > 0 && await l.isVisible().catch(() => false)) {
        loc = l; found = true; break;
      }
    }
  }

  if (!found) {
    log(`MISS: "${field.label}" (${selector})`);
    return false;
  }

  // React custom select (Greenhouse EEO widgets etc.)
  if (isReactSelect || type === 'react-select') {
    return await fillReactSelect(page, loc, field.label, value);
  }

  // Native select
  if (type === 'select') {
    // Try value match, then label match, then partial label match
    const ok = await loc.selectOption({ value }).then(() => true).catch(() => false)
            || await loc.selectOption({ label: value }).then(() => true).catch(() => false)
            || await selectByPartialLabel(loc, value);
    if (ok) log(`select: "${field.label}" -> "${value}"`);
    else    log(`WARN: select "${field.label}" could not find option "${value}"`);
    return ok;
  }

  // Textarea
  if (type === 'textarea') {
    // Greenhouse cover letter: click "Enter manually" if textarea isn't visible
    if (!await loc.isVisible().catch(() => false)) {
      const btn = page.locator('button:has-text("Enter manually"), a:has-text("Enter manually")').first();
      if (await btn.count() > 0) {
        await btn.click();
        await page.waitForTimeout(600);
        // Re-find after click
        loc = page.locator(selector).first();
        if (!await loc.isVisible().catch(() => false)) {
          // Find the newly revealed textarea
          loc = page.locator('textarea:visible').last();
        }
      }
    }
    await loc.focus().catch(() => null);
    await loc.evaluate((el, nextValue) => {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, nextValue);
      else el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, value);
    const finalValue = await loc.inputValue().catch(() => '');
    log(`textarea: "${field.label}" -> len=${finalValue.length} exact_match=${finalValue === value} preview="${short(finalValue, 80)}"`);
    return true;
  }

  // Standard text / email / tel / url inputs
  await loc.fill(value);
  const finalValue = await loc.inputValue().catch(() => '');
  log(`input: "${field.label}" -> len=${finalValue.length} exact_match=${finalValue === value} preview="${short(finalValue, 80)}"`);
  return true;
}

async function selectByPartialLabel(loc, value) {
  try {
    const options = await loc.locator('option').all();
    for (const opt of options) {
      const text = (await opt.textContent() || '').trim();
      if (text.toLowerCase().includes(value.toLowerCase()) ||
          value.toLowerCase().includes(text.toLowerCase().substring(0, 8))) {
        const optValue = await opt.getAttribute('value');
        if (optValue !== null) {
          await loc.selectOption({ value: optValue });
          return true;
        }
      }
    }
  } catch {}
  return false;
}

async function fillReactSelect(page, loc, label, value) {
  try {
    // Click to open the dropdown
    await loc.click();
    await page.waitForTimeout(400);

    // Try various option selectors
    const escaped = value.replace(/'/g, "\\'").replace(/"/g, '\\"');
    const optionSelectors = [
      `[role="option"]:has-text("${escaped}")`,
      `.select__option:has-text("${escaped}")`,
      `[class*="option"]:has-text("${escaped}")`,
      `li[class*="option"]:has-text("${escaped}")`,
      `div[class*="menu"] div:has-text("${escaped}")`,
    ];

    for (const sel of optionSelectors) {
      const opt = page.locator(sel).first();
      if (await opt.count() > 0 && await opt.isVisible().catch(() => false)) {
        await opt.click();
        log(`react-select: "${label}" -> "${value}"`);
        return true;
      }
    }

    // Option not found — try partial match
    const allOptions = await page.locator('[role="option"], .select__option').all();
    for (const opt of allOptions) {
      const text = (await opt.textContent() || '').trim();
      if (text.toLowerCase().includes(value.toLowerCase().substring(0, 8))) {
        await opt.click();
        log(`react-select (partial): "${label}" -> "${text}"`);
        return true;
      }
    }

    // Close the dropdown
    await page.keyboard.press('Escape');
    log(`WARN: react-select "${label}" could not find option "${value}"`);
    return false;
  } catch (e) {
    log(`WARN: react-select "${label}": ${e.message}`);
    return false;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

(async () => {
  if (mode === 'scrape') await runScrape();
  else                   await runFill();
})();