export const dumpColumns = {
  kokyaku_master: ['customer_id', 'name', 'name_kana', 'gender', 'phone_number', 'postal_code', 'prefecture', 'address', 'birth_date'],
  kouza_master: ['account_id', 'branch_id', 'account_number', 'customer_id', 'pin', 'bank_code', 'balance'],
  torihiki_table: ['deal_id', 'bank_id', 'deal_date', 'deal_code', 'price', 'inbank_price', 'comment']
};

export function parseMysqlValues(source) {
  let index = 0;
  const rows = [];
  const skip = () => { while (/\s/.test(source[index] || '') && index < source.length) index++; };
  const expect = char => { skip(); if (source[index++] !== char) throw new Error('Invalid MySQL INSERT values'); };
  const value = () => {
    skip();
    if (source[index] === "'") {
      index++;
      let result = '';
      while (index < source.length) {
        const char = source[index++];
        if (char === '\\') {
          if (index >= source.length) throw new Error('Unterminated SQL escape');
          const escaped = source[index++];
          result += ({ '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' })[escaped] ?? escaped;
        } else if (char === "'") {
          if (source[index] === "'") { result += "'"; index++; }
          else return result;
        } else result += char;
      }
      throw new Error('Unterminated SQL string');
    }
    const start = index;
    while (index < source.length && !/[,)\s]/.test(source[index])) index++;
    const literal = source.slice(start, index);
    if (literal === 'NULL') return null;
    // Preserve integer text, including BIGINTs that exceed JavaScript precision.
    if (/^-?\d+$/.test(literal)) return literal;
    throw new Error('Unsupported SQL literal');
  };
  while (true) {
    expect('(');
    const row = [value()];
    skip();
    while (source[index] === ',') { index++; row.push(value()); skip(); }
    expect(')'); rows.push(row); skip();
    if (source[index] === ',') { index++; continue; }
    expect(';'); skip();
    if (index !== source.length) throw new Error('Unexpected SQL after INSERT');
    return rows;
  }
}

export function readBankDump(dump) {
  const data = {};
  for (const [name, columns] of Object.entries(dumpColumns)) {
    const pattern = new RegExp('^INSERT INTO `' + name + '` VALUES ([^\\r\\n]+;)\\s*$', 'gm');
    data[name] = [...dump.matchAll(pattern)].flatMap(match => parseMysqlValues(match[1]));
    if (data[name].some(row => row.length !== columns.length)) throw new Error(`Column count mismatch: ${name}`);
  }
  if (!data.kokyaku_master.length || !data.kouza_master.length) throw new Error('Customer/account seed data is missing');
  return data;
}
