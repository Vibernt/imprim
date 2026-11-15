// Minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1-10 (up to 213 bytes),
// enough for an otpauth:// URI. Renders as an SVG string. No dependencies.
const LEVEL_M = 0b00;
// [total codewords, EC codewords per block, [[blocks, data codewords per block], ...]] for level M.
const VERSIONS = [null,
    [26, 10, [[1, 16]]], [44, 16, [[1, 28]]], [70, 26, [[1, 44]]], [100, 18, [[2, 32]]], [134, 24, [[2, 43]]],
    [172, 16, [[4, 27]]], [196, 18, [[4, 31]]], [242, 22, [[2, 38], [2, 39]]], [292, 22, [[3, 36], [2, 37]]],
    [346, 26, [[4, 43], [1, 44]]]];
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
function generator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= mul(poly[j], EXP[i]); }
        poly = next;
    }
    return poly;
}
function reedSolomon(data, degree) {
    const gen = generator(degree), rest = [...data, ...new Array(degree).fill(0)];
    for (let i = 0; i < data.length; i++) {
        const factor = rest[i];
        if (factor) for (let j = 0; j < gen.length; j++) rest[i + j] ^= mul(gen[j], factor);
    }
    return rest.slice(data.length);
}
const dataCapacity = version => VERSIONS[version][2].reduce((sum, [blocks, size]) => sum + blocks * size, 0);
function codewords(bytes, version) {
    const capacity = dataCapacity(version), countBits = version < 10 ? 8 : 16, bits = [];
    const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4); push(bytes.length, countBits);
    for (const byte of bytes) push(byte, 8);
    push(0, Math.min(4, capacity * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
    for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 ? 0x11 : 0xec);
    // Split into blocks, add EC per block, then interleave data and EC codewords.
    const [, ecPerBlock, groups] = VERSIONS[version], blocks = [];
    let offset = 0;
    for (const [count, size] of groups) for (let i = 0; i < count; i++) { const block = data.slice(offset, offset += size); blocks.push({ block, ec: reedSolomon(block, ecPerBlock) }); }
    const out = [], longest = Math.max(...blocks.map(b => b.block.length));
    for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.block.length) out.push(b.block[i]);
    for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) out.push(b.ec[i]);
    return out;
}
function bch(value, poly, bits) {
    let v = value << bits;
    const top = 31 - Math.clz32(poly);
    while (v && 31 - Math.clz32(v) >= top) v ^= poly << (31 - Math.clz32(v) - top);
    return (value << bits) | v;
}
const formatBits = mask => bch((LEVEL_M << 3) | mask, 0x537, 10) ^ 0x5412;
const versionBits = version => bch(version, 0x1f25, 12);
const MASKS = [(r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0];
function base(version) {
    const size = 17 + 4 * version, modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c, dark) => { if (r >= 0 && c >= 0 && r < size && c < size) { modules[r][c] = dark; fixed[r][c] = true; } };
    for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]])
        for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++)
            set(r0 + r, c0 + c, r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)));
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const centres = ALIGNMENT[version];
    for (const r of centres) for (const c of centres) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
    // Reserve format and version areas; written per mask below.
    for (let i = 0; i < 9; i++) if (i !== 6) { set(8, i, false); set(i, 8, false); }
    for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
    set(size - 8, 8, true); // the dark module
    if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(i, size - 11 + j, false); set(size - 11 + j, i, false); }
    return { size, modules, fixed };
}
function place({ size, modules, fixed }, data) {
    const bits = data.flatMap(byte => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (byte >>> i) & 1));
    let index = 0, upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let step = 0; step < size; step++) {
            const row = upward ? size - 1 - step : step;
            for (const col of [right, right - 1]) if (!fixed[row][col]) modules[row][col] = Boolean(bits[index++]);
        }
        upward = !upward;
    }
}
function finish(grid, version, mask) {
    const { size, fixed } = grid, m = grid.modules.map(row => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fixed[r][c] && MASKS[mask](r, c)) m[r][c] = !m[r][c];
    const format = formatBits(mask), bit = i => Boolean((format >>> i) & 1);
    for (let i = 0; i <= 5; i++) m[8][i] = bit(14 - i);
    m[8][7] = bit(8); m[8][8] = bit(7); m[7][8] = bit(6);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(14 - i);
    // Second copy: bits 14..8 up the left column from the bottom, bits 0..7 along row 8 from the right edge.
    for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = bit(14 - i);
    for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bit(i);
    m[size - 8][8] = true;
    if (version >= 7) {
        const v = versionBits(version);
        for (let i = 0; i < 18; i++) { const dark = Boolean((v >>> i) & 1), a = Math.floor(i / 3), b = size - 11 + (i % 3); m[a][b] = dark; m[b][a] = dark; }
    }
    return m;
}
function penalty(m) {
    const size = m.length;
    let score = 0;
    for (const line of [...m, ...m[0].map((_, c) => m.map(row => row[c]))]) {
        for (let i = 0, run = 1; i < size; i++) {
            if (i + 1 < size && line[i + 1] === line[i]) { run++; continue; }
            if (run >= 5) score += run - 2;
            run = 1;
        }
        const text = line.map(d => d ? '1' : '0').join('');
        score += 40 * ((text.match(/(?=10111010000)/g) || []).length + (text.match(/(?=00001011101)/g) || []).length);
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++)
        if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    const dark = m.flat().filter(Boolean).length;
    return score + 10 * Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5);
}
// Returns the module matrix (true = dark). `mask` forces a mask pattern (tests); otherwise the lowest penalty wins.
export function qrMatrix(text, { mask } = {}) {
    const bytes = [...new TextEncoder().encode(text)];
    const version = VERSIONS.findIndex((v, i) => i > 0 && (dataCapacity(i) * 8 - 4 - (i < 10 ? 8 : 16)) / 8 >= bytes.length);
    if (version < 1) throw new RangeError('Text too long for a version 10 QR code.');
    const grid = base(version);
    place(grid, codewords(bytes, version));
    if (mask !== undefined) return finish(grid, version, mask);
    let best;
    for (let candidate = 0; candidate < 8; candidate++) {
        const m = finish(grid, version, candidate), score = penalty(m);
        if (!best || score < best.score) best = { m, score };
    }
    return best.m;
}
export function qrSvg(text, { scale = 4, margin = 4, label = 'QR code' } = {}) {
    const m = qrMatrix(text), size = m.length + margin * 2;
    let path = '';
    m.forEach((row, r) => row.forEach((dark, c) => { if (dark) path += `M${c + margin} ${r + margin}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * scale}" height="${size * scale}" role="img" aria-label="${label.replace(/[<>&"]/g, '')}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
