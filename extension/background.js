'use strict';

// background.js — service worker
// Handles the floating button click, runs: scrape → Groq fill → inject.

const ENGINE = 'http://127.0.0.1:38471';

// ─── Engine comms ─────────────────────────────────────────────────────────────

async function engineGet(path) {
  const res = await fetch(`${ENGINE}${path}`);
  if (!res.ok) throw new Error(`Engine GET ${path} → ${res.status}`);
  return res.json();
}

async function enginePost(path, body) {
  const res = await fetch(`${ENGINE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Engine POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Logging ──────────────────────────────────────────────────────────────────
// All log() calls POST to /api/log so they appear in the engine cmd console.
// DevTools console also receives them for in-browser debugging.

async function log(level, message) {
  if (level === 'warn' || level === 'error') {
    console.warn(`[JobHunt][${level}] ${message}`);
  } else {
    console.log(`[JobHunt] ${message}`);
  }
  try {
    await fetch(`${ENGINE}/api/log`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ level, source: 'extension', message }),
    });
  } catch { /* engine may not be running yet */ }
}

// ─── Content script comms ─────────────────────────────────────────────────────

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(r);
    });
  });
}

function setFloat(tabId, state, msg) {
  chrome.tabs.sendMessage(tabId, { type: 'SET_FLOAT_STATE', state, msg }).catch(() => null);
}

async function getCompanyFromTab(tabId) {
  try {
    const info = await sendToTab(tabId, { type: 'GET_PAGE_INFO' });
    return (info.company || '').trim().slice(0, 60) || 'Company';
  } catch {
    return 'Company';
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function runAutoApply(tabId) {
  await log('info', 'Auto Apply started');
  setFloat(tabId, 'working', 'Reading fields…');

  // 1. Load profile
  let profile;
  try {
    profile = await engineGet('/api/profile');
    if (!profile?.firstName) throw new Error('No profile saved — open JobHunt and save your profile first');
    await log('info', `Profile loaded: ${profile.firstName} ${profile.lastName}`);
  } catch (e) {
    await log('error', `Profile load failed: ${e.message}`);
    setFloat(tabId, 'error', 'Engine offline or no profile');
    return;
  }

  // 2. Scrape
  let fields;
  try {
    const res = await sendToTab(tabId, { type: 'SCRAPE_FIELDS' });
    fields = res.fields;
    await log('info', `Scraped ${fields.length} fields`);
    setFloat(tabId, 'working', `Filling ${fields.length} fields with Groq…`);
  } catch (e) {
    await log('error', `Scrape failed: ${e.message}`);
    setFloat(tabId, 'error', 'Scrape failed');
    return;
  }

  // 3. Fill with Groq
  const company = await getCompanyFromTab(tabId);
  try {
    fields = await fillWithGroq(fields, profile, company);
  } catch (e) {
    await log('error', `Groq fill failed: ${e.message}`);
    setFloat(tabId, 'error', 'Groq error');
    return;
  }

  // 4. Inject
  try {
    setFloat(tabId, 'working', 'Injecting into form…');
    const res = await sendToTab(tabId, { type: 'INJECT_FIELDS', fields });
    await log('info', `Injected ${res.filled} of ${fields.filter(f => f.type !== 'file').length} fields`);
    setFloat(tabId, 'done', `${res.filled} fields filled`);
  } catch (e) {
    await log('error', `Inject failed: ${e.message}`);
    setFloat(tabId, 'error', 'Inject failed');
  }
}

// ─── Groq fill ────────────────────────────────────────────────────────────────

async function fillWithGroq(fields, profile, company) {
  const isCover = (f) =>
    f.label.toLowerCase().includes('cover') ||
    f.label.toLowerCase().includes('letter') ||
    f.selector === '#cover_letter_text' ||
    f.selector === '#cover_letter';

  const shortFields = fields.filter(f => f.type !== 'file' && !isCover(f));
  const coverFields = fields.filter(f => f.type !== 'file' && isCover(f));
  const answers = {};

  await log('info', `Groq: ${shortFields.length} short fields, ${coverFields.length} cover letter fields`);

  // Pass 1 — short fields
  if (shortFields.length > 0) {
    const fieldSummary = shortFields.map(f => ({
      selector: f.selector,
      label:    f.label,
      type:     f.type,
      required: f.required,
      options:  f.options.slice(0, 30).map(o => o.label),
    }));

    const system = `You are filling out a job application form.
Return ONLY a JSON array — no markdown, no explanation:
[{ "selector": "<selector>", "value": "<answer>" }, ...]
Rules:
- For select fields, value MUST exactly match one of the provided options.
- EEO gender: male→"Male", female→"Female", prefer_not→"I prefer not to say" or closest.
- EEO race: white→"White", black→"Black or African American", hispanic→"Hispanic or Latino", asian→"Asian", prefer_not→"Decline to self identify".
- EEO veteran: yes→"Protected Veteran", no→"I am not a protected veteran", prefer_not→"I prefer not to say".
- EEO disability: yes→"Yes, I have a disability", no→"No, I don't have a disability", prefer_not→"I Don't Wish to Answer".
- Sponsorship: us_citizen/green_card → No, h1b/other → Yes.
- Country questions: use the applicant's country field.
- One sentence max per answer.`;

    try {
      const data = await enginePost('/api/llm', {
        system,
        messages:   [{ role: 'user', content: `${buildProfileBlock(profile)}\n\nFORM FIELDS:\n${JSON.stringify(fieldSummary, null, 2)}` }],
        max_tokens: 1500,
      });
      const parsed = JSON.parse((data.text || '').replace(/```json|```/g, '').trim());
      parsed.forEach(a => { if (a.selector && a.value) answers[a.selector] = a.value; });
      await log('info', `Pass 1: ${parsed.length} answers received`);
    } catch (e) {
      await log('warn', `Pass 1 failed: ${e.message}`);
    }
  }

  // Pass 2 — cover letter
  if (coverFields.length > 0) {
    const system = `You are writing a cover letter for a job application.
Write ONLY the cover letter as plain text — no JSON, no markdown, nothing else.
3 short paragraphs separated by a blank line. Under 300 words. No placeholders.
Use the real company name: ${company}`;

    try {
      const data = await enginePost('/api/llm', {
        system,
        messages:   [{ role: 'user', content: `${buildProfileBlock(profile)}\n\nRESUME:\n${profile.resumeText || '(not provided)'}\n\nCOVER LETTER TEMPLATE:\n${profile.coverLetterText || '(not provided)'}` }],
        max_tokens: 600,
      });
      const text = (data.text || '').trim();

      if (text) {
        coverFields.forEach(f => { answers[f.selector] = text; });
        await log('info', `Cover letter generated: ${text.length} chars for ${company}`);

        // Save — awaited so any error appears in the log immediately
        if (profile.saveCoverLetterEnabled !== false) {
          try {
            const saved = await enginePost('/api/cover-letter/save', {
              firstName:   profile.firstName   || '',
              lastName:    profile.lastName    || '',
              companyName: company,
              content:     text,
              saveDir:     profile.coverLetterSaveDir || '',
            });
            await log('info', `Cover letter saved → ${saved.path}`);
          } catch (saveErr) {
            await log('error', `Cover letter save failed: ${saveErr.message}`);
          }
        } else {
          await log('info', 'Cover letter save skipped (disabled in profile)');
        }
      } else {
        await log('warn', 'Cover letter: Groq returned empty response');
      }
    } catch (e) {
      await log('error', `Cover letter Groq call failed: ${e.message}`);
    }
  }

  // Merge answers back
  const merged = fields.map(f => {
    const val = answers[f.selector];
    if (!val) return f;
    if ((f.type === 'select' || f.isReactSelect) && f.options.length > 0) {
      const exact = f.options.find(
        o => o.label.toLowerCase() === val.toLowerCase() ||
             o.value.toLowerCase() === val.toLowerCase()
      );
      if (exact) return { ...f, value: exact.label };
      const fuzzy = f.options.find(
        o => o.label.toLowerCase().includes(val.toLowerCase().slice(0, 6)) ||
             val.toLowerCase().includes(o.label.toLowerCase().slice(0, 6))
      );
      if (fuzzy) return { ...f, value: fuzzy.label };
    }
    return { ...f, value: val };
  });

  const filledCount = merged.filter(f => f.value && f.type !== 'file').length;
  await log('info', `Groq complete: ${filledCount}/${fields.length} fields have values`);
  return merged;
}

// ─── Profile block ────────────────────────────────────────────────────────────

function buildProfileBlock(p) {
  return `APPLICANT PROFILE:
Name: ${p.firstName || ''} ${p.lastName || ''}
Email: ${p.email || ''}
Phone: ${p.phone || ''}
Location: ${p.location || ''}
Country: ${p.country || 'United States'}
City: ${p.city || ''}
State: ${p.state || ''}
Current title: ${p.currentTitle || ''}
Years experience: ${p.yearsExperience || ''}
Work authorization: ${p.workAuth || ''}
Requires sponsorship: ${p.requiresSponsorship ? 'yes' : 'no'}
Authorized to work: ${p.authorizedToWork !== false ? 'yes' : 'no'}
Desired salary: ${p.desiredSalary || ''}
Notice period: ${p.noticePeriod || ''}
LinkedIn: ${p.linkedinURL || ''}
GitHub: ${p.githubURL || ''}
Previously employed here: ${p.previouslyEmployed ? 'yes' : 'no'}
Employment restrictions: ${p.employmentRestrictions || 'none'}
Gender (EEO): ${p.gender || 'prefer_not'}
Race/ethnicity (EEO): ${p.race || 'prefer_not'}
Veteran status (EEO): ${p.veteranStatus || 'prefer_not'}
Disability status (EEO): ${p.disabilityStatus || 'prefer_not'}`;
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'FLOAT_BTN_CLICKED' && sender.tab?.id) {
    runAutoApply(sender.tab.id);
  }
});