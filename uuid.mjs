
function uuidToBytes(uuid) {
    return Uint8Array.from(uuid.replace(/-/g, '').match(/.{2}/g).map(b => parseInt(b, 16)));
}

function bytesToUuid(buf) {
    const hex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20)
    ].join('-');
}

function getRandomBytes(len = 16) {
    const buf = new Uint8Array(len);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(buf);
    } else {
        for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    return buf;
}

function uuidv4() {
    const rnd = getRandomBytes(16);
    rnd[6] = (rnd[6] & 0x0f) | 0x40;
    rnd[8] = (rnd[8] & 0x3f) | 0x80;
    return bytesToUuid(rnd);
}

function sha1Fallback(data) {
    function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }

    const toUint8Array = str => (str instanceof Uint8Array ? str : new TextEncoder().encode(str));
    data = toUint8Array(data);
    const l = data.length;
    const w = [];

    for (let i = 0; i < l - 3; i += 4)
        w.push((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]);

    let i = l - (l % 4), temp =
        (data[i] << 24) | ((data[i + 1] || 0) << 16) | ((data[i + 2] || 0) << 8) | (data[i + 3] || 0);
    w.push(temp);

    const bitLen = l * 8;
    w.push(0x80 << 24);
    while (w.length % 16 !== 14) w.push(0);
    w.push((bitLen / 0x100000000) >>> 0);
    w.push(bitLen >>> 0);

    let h0 = 0x67452301,
        h1 = 0xEFCDAB89,
        h2 = 0x98BADCFE,
        h3 = 0x10325476,
        h4 = 0xC3D2E1F0;

    for (let b = 0; b < w.length; b += 16) {
        const W = w.slice(b, b + 16);
        for (let t = 16; t < 80; t++)
            W[t] = rotl(W[t - 3] ^ W[t - 8] ^ W[t - 14] ^ W[t - 16], 1);

        let a = h0, b_ = h1, c = h2, d = h3, e = h4;

        for (let t = 0; t < 80; t++) {
            const f = t < 20 ? ((b_ & c) | (~b_ & d))
                : t < 40 ? (b_ ^ c ^ d)
                : t < 60 ? ((b_ & c) | (b_ & d) | (c & d))
                : (b_ ^ c ^ d);
            const k = t < 20 ? 0x5A827999
                : t < 40 ? 0x6ED9EBA1
                : t < 60 ? 0x8F1BBCDC
                : 0xCA62C1D6;

            const temp = (rotl(a, 5) + f + e + k + W[t]) >>> 0;
            e = d; d = c; c = rotl(b_, 30) >>> 0; b_ = a; a = temp;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b_) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
    }

    const digest = new Uint8Array(20);
    [h0, h1, h2, h3, h4].forEach((h, i) => {
        digest[i * 4] = h >>> 24;
        digest[i * 4 + 1] = (h >>> 16) & 0xff;
        digest[i * 4 + 2] = (h >>> 8) & 0xff;
        digest[i * 4 + 3] = h & 0xff;
    });

    return digest;
}

function uuidv5(name, namespace) {
    const nsBytes = uuidToBytes(namespace);
    const nameBytes = new TextEncoder().encode(name);
    const toHash = new Uint8Array(nsBytes.length + nameBytes.length);
    toHash.set(nsBytes);
    toHash.set(nameBytes, nsBytes.length);

    const hash = sha1Fallback(toHash);

    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;

    return bytesToUuid(hash.slice(0, 16));
}

export { uuidv4, uuidv5 };
