// Dot-matrix marks. The IMPRIM wordmark signs every page ("Powered by"), and a brand with no uploaded mark gets its
// initial drawn the same way. Lit dots take the current colour; unlit ones stay faint, so the matrix reads as a display.
// A 5×7 font: each glyph is seven rows, one base-32 digit a row, the five bits of a row read left to right.
const FONT = {
    0: 'ehjlphe', 1: '4c4444e', 2: 'eh1248v', 3: 'v2421he', 4: '26aiv22', 5: 'vgu11he', 6: '68guhhe', 7: 'v124888', 8: 'ehhehhe', 9: 'ehhf12c',
    A: 'ehhvhhh', B: 'uhhuhhu', C: 'ehggghe', D: 'uhhhhhu', E: 'vgguggv', F: 'vgguggg', G: 'ehgnhhf', H: 'hhhvhhh', I: 'e44444e', J: '72222ic',
    K: 'hikokih', L: 'ggggggv', M: 'hrllhhh', N: 'hhpljhh', O: 'ehhhhhe', P: 'uhhuggg', Q: 'ehhhlid', R: 'uhhukih', S: 'fgge11u', T: 'v444444',
    U: 'hhhhhhe', V: 'hhhhha4', W: 'hhhllla', X: 'hha4ahh', Y: 'hhha444', Z: 'v1248gv'
};
// A glyph for any other first character: a diamond.
const OTHER = '04evve4';
const rows = glyph => [...glyph].map(digit => parseInt(digit, 32).toString(2).padStart(5, '0'));
// Each dot is a circle drawn as two arcs, so a whole mark is two short paths.
const dot = (cx, cy) => `M${(cx - 0.42).toFixed(2)} ${cy}a.42 .42 0 1 0 .84 0a.42 .42 0 1 0-.84 0`;
function matrix(glyphs) {
    let x = 0; const lit = [], unlit = [];
    for (const glyph of glyphs) {
        rows(glyph).forEach((row, y) => [...row].forEach((cell, dx) => (cell === '1' ? lit : unlit).push(dot(x + dx + 0.5, y + 0.5))));
        x += 6;
    }
    return { width: x - 1, lit: lit.join(''), unlit: unlit.join(''), paths: `<path opacity=".14" d="${unlit.join('')}"/><path d="${lit.join('')}"/>` };
}
// Any text in the dot matrix (letters and digits; anything else is a diamond), for drawings that place and colour
// the dots themselves: { width, lit, unlit } with path data in units of one dot pitch, seven units tall.
export const dotMatrix = text => matrix([...String(text).toUpperCase()].map(ch => FONT[ch] || OTHER));
const wordmark = matrix([...'IMPRIM'].map(letter => FONT[letter]));
// The IMPRIM wordmark. `size` is "sm" for the "Powered by" line.
export const dotLogo = (size = '') => `<svg class="fd-wordmark"${size ? ` data-size="${size}"` : ''} viewBox="0 0 ${wordmark.width} 7" fill="currentColor" role="img" aria-label="Imprim">${wordmark.paths}</svg>`;
// A brand's initial as a square mark, for fd-brand-mark and fd-topbar-brand.
export function dotMark(name) {
    const initial = String(name || '').trim().normalize('NFD')[0]?.toUpperCase() ?? '';
    return `<svg viewBox="-1 0 7 7" fill="currentColor" aria-hidden="true">${matrix([FONT[initial] || OTHER]).paths}</svg>`;
}
