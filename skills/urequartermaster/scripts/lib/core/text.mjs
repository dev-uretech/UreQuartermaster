// Sanitizing of third-party text before it is printed or injected into a prompt.
// Terminal escapes, other control characters and bidi overrides never reach the output.
const CTRL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;
/** For single-line fields: newlines become spaces. */
export const clean = (v) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(CTRL, '');
/** For file bodies: newlines and tabs stay. */
export const cleanBody = (v) => String(v).replace(CTRL, '');
