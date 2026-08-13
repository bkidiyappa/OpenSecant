/**
 * Turn captured recorder events into Action-Library-shaped English steps.
 */

function pickName(target) {
  if (!target) return '';
  const attrs = target.attributes || {};
  const candidates = [
    attrs['aria-label'],
    target.labelText,
    target.text,
    attrs.placeholder,
    attrs.title,
    attrs.alt,
    attrs['data-testid'] || attrs['data-test'] || attrs.testdataid,
    attrs.name,
    attrs.id,
  ];
  for (const c of candidates) {
    const t = String(c || '').replace(/\s+/g, ' ').trim();
    if (t) {
      // Prefer short product titles from long aria-labels (before ". Current price")
      const short = t.split(/\.\s+Current price/i)[0].split(/\.\s+₹/)[0].trim();
      return short.length > 80 ? `${short.slice(0, 77)}…` : short;
    }
  }
  return target.tag || 'element';
}

function pickFieldName(target) {
  if (!target) return 'field';
  const attrs = target.attributes || {};
  const candidates = [
    target.labelText,
    attrs['aria-label'],
    attrs.placeholder,
    attrs.name,
    attrs['data-testid'] || attrs['data-test'],
    attrs.id,
  ];
  for (const c of candidates) {
    const t = String(c || '').replace(/\s+/g, ' ').trim();
    if (t) return t.length > 60 ? `${t.slice(0, 57)}…` : t;
  }
  return target.tag || 'field';
}

/** Stable key for the same form control across progressive typing. */
function fieldIdentity(target) {
  if (!target) return '';
  const attrs = target.attributes || {};
  return [
    attrs['data-testid'] || attrs['data-test'] || attrs.testdataid || '',
    attrs.name || '',
    attrs.id || '',
    attrs.placeholder || '',
    attrs['aria-label'] || '',
    target.labelText || '',
    target.tag || '',
  ].join('|').toLowerCase();
}

function sameControl(a, b) {
  if (!a || !b) return false;
  const idA = fieldIdentity(a);
  const idB = fieldIdentity(b);
  if (idA && idB && idA === idB) return true;
  return pickFieldName(a).toLowerCase() === pickFieldName(b).toLowerCase();
}

function sameVisibleName(a, b) {
  if (!a || !b) return false;
  return pickName(a).toLowerCase() === pickName(b).toLowerCase();
}

/**
 * @param {object} event — recorder step payload
 * @returns {string} natural-language step
 */
function eventToNlStep(event) {
  if (!event) return '';

  if (event.type === 'navigate') {
    return `open ${event.url}`;
  }

  if (event.type === 'fill') {
    const field = pickFieldName(event.target);
    const value = String(event.value ?? '');
    return `Fill ${field} as ${value}`;
  }

  if (event.type === 'select') {
    const field = pickFieldName(event.target);
    return `Select ${event.value} from ${field}`;
  }

  if (event.type === 'check') {
    return `Check ${pickName(event.target)}`;
  }

  if (event.type === 'uncheck') {
    return `Uncheck ${pickName(event.target)}`;
  }

  if (event.type === 'press') {
    const key = event.key || 'Enter';
    const field = event.target ? pickFieldName(event.target) : '';
    const isGenericField = !field || field === 'field' || field === 'input' || field === 'textarea' || field === 'body' || field === 'html';
    if (field && !isGenericField) {
      return `Press ${key} in ${field}`;
    }
    return `Press ${key}`;
  }

  if (event.type === 'click') {
    const name = pickName(event.target);
    return `Click on ${name}`;
  }

  return `Click on ${pickName(event.target) || 'element'}`;
}

/**
 * Collapse noisy recorder events while keeping intentional repeats of distinct actions.
 * - One fill per field streak (keep final typed value)
 * - Drop focus-clicks before fill/check on the same control
 * - Drop duplicate consecutive navigates
 *
 * @param {Array<{nlStep: string, code: string, event: object}>} items
 */
function consolidateRecordedItems(items) {
  const out = [];

  for (const item of items) {
    const prev = out[out.length - 1];
    const ev = item.event;

    if (
      ev?.type === 'navigate' &&
      prev?.event?.type === 'navigate' &&
      prev.event.url === ev.url
    ) {
      continue;
    }

    // Progressive typing → keep only the latest fill for the same field
    if (ev?.type === 'fill' && prev?.event?.type === 'fill' && sameControl(prev.event.target, ev.target)) {
      out[out.length - 1] = item;
      continue;
    }

    // Click then fill same field (focus) → drop the click
    if (
      ev?.type === 'fill' &&
      prev?.event?.type === 'click' &&
      sameControl(prev.event.target, ev.target)
    ) {
      out[out.length - 1] = item;
      continue;
    }

    // Click then check/uncheck same control → keep check only
    if (
      (ev?.type === 'check' || ev?.type === 'uncheck') &&
      prev?.event?.type === 'click' &&
      sameVisibleName(prev.event.target, ev.target)
    ) {
      out[out.length - 1] = item;
      continue;
    }

    out.push(item);
  }

  // Rebuild nlStep/code after replacements (callers usually already set them;
  // ensure nlStep matches final event value for replaced fills)
  return out.map((item) => {
    if (!item.event) return item;
    const nlStep = eventToNlStep(item.event);
    return {
      ...item,
      nlStep,
      step: nlStep,
    };
  });
}

module.exports = {
  pickName,
  pickFieldName,
  fieldIdentity,
  eventToNlStep,
  consolidateRecordedItems,
};
