export function clipText(text: string, maxLength: number): string {
    let end = Math.min(text.length, maxLength);
    // Inspect UTF-16 units here: code points would hide a pair split by the bound.
    const before = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    if (end < text.length && before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end--;
    }
    return text.slice(0, end);
}
