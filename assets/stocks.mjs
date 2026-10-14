import { companies } from './stock-companies.mjs';
export { companies };
export const companyById = id => companies.find(company => company.id === id);
export class StockError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new StockError(message, status); };
const safe = value => Number.isSafeInteger(value) && value >= 0;
const clone = value => JSON.parse(JSON.stringify(value));
export const feeFor = amount => Math.max(1, Math.ceil(amount * .0005));
export function quantityForBudget(budget, price, unit = 1) {
  if (!safe(budget) || budget < 1 || !safe(price) || price < 1 || ![1,100].includes(unit)) return 0;
  let low = 0, high = Math.floor(Math.min(100000, Math.floor(budget / price)) / unit);
  while (low < high) {
    const lots = Math.ceil((low + high) / 2), amount = lots * unit * price;
    if (safe(amount) && safe(amount + feeFor(amount)) && amount + feeFor(amount) <= budget) low = lots;
    else high = lots - 1;
  }
  return low * unit;
}
export function priceLimit(base) {
  const limits = [[100,30],[200,50],[500,80],[700,100],[1000,150],[1500,300],[2000,400],[3000,500],[5000,700],[7000,1000],[10000,1500],[15000,3000],[20000,4000],[30000,5000],[50000,7000],[70000,10000],[100000,15000],[150000,30000],[200000,40000],[300000,50000],[500000,70000],[700000,100000],[1000001,150000]];
  return limits.find(([ceiling]) => base < ceiling)?.[1] || 150000;
}
export const limitsFor = quote => ({ low: Math.max(1, quote.previousClose - priceLimit(quote.previousClose)), high: Math.min(1000000, quote.previousClose + priceLimit(quote.previousClose)) });
export function bookFor(quote) {
  const { low, high } = limitsFor(quote), spread = Math.max(1, Math.round(quote.price * .0007));
  // At a price limit, the unavailable side has no quote.
  const bid = quote.price === low ? null : Math.max(low, quote.price - spread);
  const ask = quote.price === high ? null : Math.min(high, quote.price + spread);
  return { bid, ask, bids: Array.from({ length: 5 }, (_, i) => ({ price: bid === null ? null : Math.max(low, bid - i * spread), quantity: (3 + (quote.volume + i * 7) % 30) * 100 })),
    asks: Array.from({ length: 5 }, (_, i) => ({ price: ask === null ? null : Math.min(high, ask + i * spread), quantity: (3 + (quote.volume + i * 11) % 30) * 100 })) };
}
export function createMarket(now = Date.now(), random = Math.random) {
  let market = { version: 1, day: 1, tick: 0, updatedAt: now, news: [{ day: 1, tick: 0, text: '練習市場が開始。価格・出来高・ニュースはすべて架空です。' }], quotes: {} };
  for (const company of companies) market.quotes[company.id] = { price: company.initialPrice, previousClose: company.initialPrice, open: company.initialPrice, high: company.initialPrice, low: company.initialPrice, volume: 0,
    candles: [{ open: company.initialPrice, high: company.initialPrice, low: company.initialPrice, close: company.initialPrice, volume: 0, day: 1, tick: 0 }] };
  for (let i = 0; i < 24; i++) market = advanceMarket(market, now + (i + 1) * 3000, random);
  market.updatedAt = now;
  return market;
}
export function advanceMarket(value, now = Date.now(), random = Math.random) {
  if (now - value.updatedAt < 3000) return value;
  const market = clone(value), nextDay = market.tick >= 329;
  market.day += nextDay ? 1 : 0; market.tick = nextDay ? 0 : market.tick + 1; market.updatedAt = now;
  const common = (random() - .5) * .003;
  const sectorMoves = Object.fromEntries([...new Set(companies.map(c => c.sector))].map(s => [s, (random() - .5) * .004]));
  const eventSector = market.tick % 20 === 0 ? companies[Math.floor(random() * companies.length)].sector : null;
  const shock = eventSector ? (random() < .5 ? -1 : 1) * (.008 + random() * .018) : 0;
  if (eventSector) market.news = [{ day: market.day, tick: market.tick, text: `【架空ニュース】${eventSector}業界の需要見通しが${shock > 0 ? '改善' : '悪化'}。関連銘柄に${shock > 0 ? '買い' : '売り'}が広がる。` }, ...market.news].slice(0, 5);
  for (const company of companies) {
    const quote = market.quotes[company.id];
    if (nextDay) { quote.previousClose = quote.price; quote.open = quote.price; quote.high = quote.price; quote.low = quote.price; quote.volume = 0; }
    const { low, high } = limitsFor(quote), open = quote.price;
    const move = common + sectorMoves[company.sector] + (random() - .5) * company.volatility + (company.sector === eventSector ? shock : 0);
    const close = Math.max(low, Math.min(high, Math.round(open * (1 + move))));
    const wick = Math.max(1, Math.round(open * random() * company.volatility * .25));
    const volume = (10 + Math.floor(random() * 300) + Math.round(Math.abs(move) * 20000)) * 100;
    const candle = { open, close, high: Math.min(high, Math.max(open, close) + wick), low: Math.max(low, Math.min(open, close) - wick), volume, day: market.day, tick: market.tick };
    quote.price = close; quote.high = Math.max(quote.high, candle.high); quote.low = Math.min(quote.low, candle.low); quote.volume += volume;
    quote.candles = [...quote.candles, candle].slice(-90);
  }
  return market;
}
export const emptyPortfolio = () => ({ version: 1, holdings: {}, orders: [], realized: 0 });
export function validPortfolio(state) {
  return state?.version === 1 && Number.isSafeInteger(state.realized) && state.holdings && typeof state.holdings === 'object' && !Array.isArray(state.holdings)
    && Object.entries(state.holdings).every(([id, h]) => companyById(id) && h && safe(h.quantity) && safe(h.cost))
    && Array.isArray(state.orders) && state.orders.length <= 200 && state.orders.every(o => o && companyById(o.symbol) && typeof o.id === 'string'
      && ['buy','sell'].includes(o.side) && ['market','limit'].includes(o.type) && ['open','filled','cancelled','expired'].includes(o.status)
      && safe(o.quantity) && o.quantity > 0 && safe(o.limitPrice) && safe(o.day)
      && (o.budget === undefined || (o.side === 'buy' && safe(o.budget) && o.budget > 0)));
}
const originalCompanyIds = ['7203','6758','7974','7267','7201','6501','6752','6503','6367','6861','8035','6857','6723','9434','9984','9432','9433','8306','8316','8411','9983','3382','8267','4755','8058','8031','4502','4503','9020','9202'];
const validQuote = q => q && !Array.isArray(q) && [q.price,q.previousClose,q.open,q.high,q.low].every(value=>safe(value)&&value>=1&&value<=1000000)
  && q.low <= q.open && q.high >= q.open && safe(q.volume) && Array.isArray(q.candles) && q.candles.length > 0 && q.candles.length <= 90
  && q.candles.every(b => b && [b.open,b.high,b.low,b.close].every(value=>safe(value)&&value>=1&&value<=1000000)
    && [b.volume,b.day,b.tick].every(safe) && b.day >= 1 && b.tick <= 329 && b.low <= Math.min(b.open,b.close) && b.high >= Math.max(b.open,b.close));
const validMarketHeader = market => market?.version === 1 && safe(market.day) && market.day >= 1 && safe(market.tick) && market.tick <= 329 && Number.isFinite(market.updatedAt) && Array.isArray(market.news)
  && market.quotes && !Array.isArray(market.quotes) && typeof market.quotes === 'object';
export function upgradeMarket(existing, now = Date.now(), random = Math.random) {
  // Keep the stored clock and quote history intact; only advanceMarket moves prices.
  if (!validMarketHeader(existing) || !originalCompanyIds.every(id => validQuote(existing.quotes[id]))
    || !Object.entries(existing.quotes).every(([id, quote]) => companyById(id) && validQuote(quote))) fail('練習市場の保存データを確認してください。', 503);
  const missing = companies.filter(company => !Object.hasOwn(existing.quotes, company.id));
  if (!missing.length) return existing;
  const market = clone(existing);
  for (const company of missing) {
    const price = company.initialPrice;
    market.quotes[company.id] = { price, previousClose: price, open: price, high: price, low: price, volume: 0,
      candles: [{ open: price, high: price, low: price, close: price, volume: 0, day: market.day, tick: market.tick }] };
  }
  return market;
}
export function validMarket(market) {
  return Boolean(validMarketHeader(market) && companies.every(c => validQuote(market.quotes[c.id]))
    && Object.keys(market.quotes).every(id => companyById(id)));
}
export const reservedCash = state => state.orders.filter(o => o.status === 'open' && o.side === 'buy').reduce((sum, o) => sum + o.limitPrice * o.quantity + feeFor(o.limitPrice * o.quantity), 0);
export const reservedShares = (state, symbol) => state.orders.filter(o => o.status === 'open' && o.side === 'sell' && o.symbol === symbol).reduce((sum, o) => sum + o.quantity, 0);
export function validateOrder(input, market) {
  if (!companyById(input.symbol)) fail('銘柄が不正です。');
  if (!['buy','sell'].includes(input.side) || !['market','limit'].includes(input.type)) fail('注文区分が不正です。');
  if (input.budget !== undefined && (input.side !== 'buy' || !safe(input.budget) || input.budget < 1)) fail('投資金額は買付時に1円以上の整数で入力してください。');
  if (![1,100].includes(input.unit) || !safe(input.quantity) || input.quantity < 1 || input.quantity > 100000 || input.quantity % input.unit) fail('数量は選択した売買単位の整数倍（最大100,000株）で入力してください。');
  if (input.type === 'limit') {
    if (!safe(input.limitPrice) || input.limitPrice < 1) fail('指値は1円以上の整数で入力してください。');
    const { low, high } = limitsFor(market.quotes[input.symbol]);
    if (input.limitPrice < low || input.limitPrice > high) fail(`指値は本日の値幅制限（${low}〜${high}円）内にしてください。`);
  }
  if (input.type === 'market' && (!safe(input.expectedPrice) || input.expectedPrice < 1)) fail('気配値を確認して注文してください。');
}
function fillOrder(state, order, price, balance, now) {
  const amount = price * order.quantity, fee = feeFor(amount), buy = order.side === 'buy';
  const h = state.holdings[order.symbol] || { quantity: 0, cost: 0 };
  if (![amount, amount + fee].every(safe)) fail('取扱上限を超えています。');
  if (buy && amount + fee > balance) fail('買付可能額が不足しています。', 409);
  if (buy && order.budget !== undefined && amount + fee > order.budget) fail('手数料を含めた買付額が投資金額を超えています。', 409);
  if (!buy && order.quantity > h.quantity) fail('保有株数が不足しています。', 409);
  const removedCost = buy ? 0 : order.quantity === h.quantity ? h.cost : Math.floor(h.cost * order.quantity / h.quantity);
  const next = { quantity: h.quantity + (buy ? order.quantity : -order.quantity), cost: buy ? h.cost + amount + fee : h.cost - removedCost };
  const nextBalance = balance + (buy ? -amount - fee : amount - fee), realized = state.realized + (buy ? 0 : amount - fee - removedCost);
  if (![next.quantity,next.cost,nextBalance].every(safe) || !Number.isSafeInteger(realized)) fail('取扱上限を超えています。');
  state.holdings[order.symbol] = next; state.realized = realized;
  Object.assign(order, { status: 'filled', price, amount, fee, filledAt: now, profit: buy ? 0 : amount - fee - removedCost });
  return nextBalance;
}
export function placeOrder(value, input, market, balance, id, now = Date.now()) {
  validateOrder(input, market);
  const state = clone(value), book = bookFor(market.quotes[input.symbol]), price = input.side === 'buy' ? book.ask : book.bid;
  if (input.type === 'market' && (price === null || price !== input.expectedPrice)) fail('気配値が変わったか、反対側の注文がありません。再確認して注文してください。', 409);
  if (state.orders.filter(o => o.status === 'open').length >= 50) fail('未約定注文は50件までです。');
  const maxPrice = input.type === 'limit' ? input.limitPrice : price, amount = maxPrice * input.quantity;
  if (!safe(amount + feeFor(amount))) fail('取扱上限を超えています。');
  if (input.side === 'buy' && input.budget !== undefined && amount + feeFor(amount) > input.budget) fail('手数料を含めた買付額が投資金額を超えています。', 409);
  if (input.side === 'buy' && amount + feeFor(amount) > balance - reservedCash(state)) fail('買付可能額が不足しています。未約定注文の拘束額も確認してください。', 409);
  if (input.side === 'sell' && input.quantity > (state.holdings[input.symbol]?.quantity || 0) - reservedShares(state, input.symbol)) fail('売却可能な保有株数が不足しています。', 409);
  const order = { id, symbol: input.symbol, side: input.side, type: input.type, quantity: input.quantity, unit: input.unit, limitPrice: input.type === 'limit' ? input.limitPrice : 0, status: 'open', day: market.day, createdAt: now };
  if (input.budget !== undefined) order.budget = input.budget;
  const crosses = price !== null && (input.type === 'market' || (input.side === 'buy' ? price <= input.limitPrice : price >= input.limitPrice));
  if (crosses) balance = fillOrder(state, order, price, balance, now);
  state.orders = [...state.orders, order];
  while (state.orders.length > 200) state.orders.splice(state.orders.findIndex(o => o.status !== 'open'), 1);
  return { state, balance, order, fills: crosses ? [order] : [] };
}
export function settleOrders(value, market, balance, now = Date.now()) {
  const state = clone(value), fills = [];
  for (const order of state.orders.filter(o => o.status === 'open')) {
    if (order.day !== market.day) { order.status = 'expired'; continue; }
    const book = bookFor(market.quotes[order.symbol]), price = order.side === 'buy' ? book.ask : book.bid;
    if (price === null || (order.side === 'buy' ? price > order.limitPrice : price < order.limitPrice)) continue;
    // Bank transactions also respect reserved cash; external balance edits can invalidate an order.
    if (order.side === 'buy' && price * order.quantity + feeFor(price * order.quantity) > balance) { order.status = 'cancelled'; continue; }
    balance = fillOrder(state, order, price, balance, now); fills.push(order);
  }
  return { state, balance, fills };
}
export function cancelOrder(value, id) {
  const state = clone(value), order = state.orders.find(o => o.id === id && o.status === 'open');
  if (!order) fail('取消できる未約定注文が見つかりません。', 409);
  order.status = 'cancelled'; return state;
}
export function simulationTime(market) {
  const minutes = 9 * 60 + market.tick + (market.tick >= 150 ? 60 : 0);
  return `練習 ${market.day}日目 ${String(Math.floor(minutes / 60)).padStart(2,'0')}:${String(minutes % 60).padStart(2,'0')}`;
}
