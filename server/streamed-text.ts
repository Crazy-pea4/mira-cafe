// Read only segments[0..1].text from a partial JSON object. This is a visual
// preview, never a parsed Reply or a source of actions, facts or saved history.
export function streamedText(source: string): string {
  let at = 0;
  const texts: string[] = [];
  const space = () => { while (/\s/.test(source[at] ?? '') && at < source.length) at++; };
  const string = () => {
    if (source[at++] !== '"') return { value: '', complete: false };
    let value = '';
    while (at < source.length) {
      const char = source[at++];
      if (char === '"') return { value, complete: true };
      if (char !== '\\') {
        if (char.charCodeAt(0) < 32) return { value, complete: false };
        value += char;
        continue;
      }
      const escaped = source[at++];
      if (escaped === 'u') {
        const hex = source.slice(at, at + 4);
        if (!/^[a-f\d]{4}$/i.test(hex)) return { value, complete: false };
        value += String.fromCharCode(parseInt(hex, 16));
        at += 4;
      } else {
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (!Object.hasOwn(escapes, escaped)) return { value, complete: false };
        value += escapes[escaped];
      }
    }
    return { value, complete: false };
  };
  function value(path: (string | number)[], depth: number): boolean {
    if (depth > 12) return false;
    space();
    if (source[at] === '"') {
      const token = string();
      if (path.length === 3 && path[0] === 'segments' &&
          typeof path[1] === 'number' && path[1] < 2 && path[2] === 'text')
        texts.push(token.value.replace(/[\uD800-\uDBFF]$/, '').slice(0, 120));
      return token.complete;
    }
    if (source[at] === '{') {
      at++;
      space();
      if (source[at] === '}') { at++; return true; }
      while (at < source.length) {
        space();
        if (source[at] !== '"') return false;
        const key = string();
        space();
        if (!key.complete || source[at++] !== ':') return false;
        if (!value([...path, key.value], depth + 1)) return false;
        space();
        const next = source[at++];
        if (next === '}') return true;
        if (next !== ',') return false;
      }
    } else if (source[at] === '[') {
      at++;
      space();
      if (source[at] === ']') { at++; return true; }
      for (let index = 0; at < source.length; index++) {
        if (!value([...path, index], depth + 1)) return false;
        space();
        const next = source[at++];
        if (next === ']') return true;
        if (next !== ',') return false;
      }
    } else {
      const primitive = source.slice(at).match(/^(?:true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?=\s|[,}\]])/i);
      if (primitive) { at += primitive[0].length; return true; }
    }
    return false;
  }
  if (source.trimStart().startsWith('{')) value([], 0);
  return texts.join('\n').slice(0, 241);
}
