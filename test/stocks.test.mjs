import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companies, createMarket, upgradeMarket, advanceMarket, emptyPortfolio, validPortfolio, validMarket, priceLimit, limitsFor, bookFor, feeFor, quantityForBudget, placeOrder, settleOrders, cancelOrder, reservedCash, reservedShares } from '../assets/stocks.mjs';
const frozenMarket = () => createMarket(100000, () => .5);
const request = (market, patch = {}) => ({ symbol: '7203', side: 'buy', type: 'market', quantity: 2, unit: 1, expectedPrice: bookFor(market.quotes['7203']).ask, ...patch });

test('100 distinct companies across sectors have source links, strengths and risks', () => {
  assert.equal(companies.length, 100); assert.equal(new Set(companies.map(c => c.id)).size, 100);
  assert.ok(new Set(companies.map(c => c.sector)).size >= 20);
  assert.ok(companies.every(c => c.name && c.business && c.strength && c.risk && c.source.startsWith('https://')));
});
test('a 30-company market gains quotes without replacing the saved market or account history', () => {
  const market = frozenMarket(), legacy = structuredClone(market);
  const originalIds = companies.slice(0,30).map(c=>c.id);
  for (const id of Object.keys(legacy.quotes)) if (!originalIds.includes(id)) delete legacy.quotes[id];
  const account = placeOrder(emptyPortfolio(), request(legacy), legacy, 20000, 'saved-order', 1);
  const accountBefore = structuredClone(account), before = structuredClone(legacy);
  const upgraded = upgradeMarket(legacy, 200000, () => .99);
  assert.ok(validMarket(upgraded)); assert.equal(Object.keys(upgraded.quotes).length, 100);
  for (const id of originalIds) assert.deepEqual(upgraded.quotes[id], before.quotes[id]);
  for (const key of ['version','day','tick','updatedAt','news']) assert.deepEqual(upgraded[key], before[key]);
  for (const company of companies.slice(30)) {
    const quote = upgraded.quotes[company.id];
    assert.equal(quote.price, company.initialPrice);
    assert.equal(quote.candles.length, 1); assert.equal(quote.candles[0].day, legacy.day); assert.equal(quote.candles[0].tick, legacy.tick);
  }
  assert.deepEqual(legacy,before); assert.deepEqual(account,accountBefore); assert.ok(validPortfolio(account.state));
  assert.equal(upgradeMarket(upgraded),upgraded);
  const corrupt = structuredClone(legacy); corrupt.quotes['7203'].price = 0;
  assert.throws(()=>upgradeMarket(corrupt),/保存データ/);
  const missingOld = structuredClone(legacy); delete missingOld.quotes['7203'];
  assert.throws(()=>upgradeMarket(missingOld),/保存データ/);
  const unknown = structuredClone(legacy); unknown.quotes['unknown'] = unknown.quotes['7203'];
  assert.throws(()=>upgradeMarket(unknown),/保存データ/);
  assert.throws(()=>upgradeMarket({...legacy,quotes:null}),/保存データ/);
  const brokenCandle=structuredClone(legacy); brokenCandle.quotes['7203'].candles[0].low=0;
  assert.throws(()=>upgradeMarket(brokenCandle),/保存データ/);
  assert.throws(()=>upgradeMarket({...legacy,tick:330}),/保存データ/);
  assert.equal(validPortfolio({...account.state,holdings:1}),false);
});
test('budget sizing uses whole shares or lots, includes fees and never spends above the budget', () => {
  for (const unit of [1,100]) for (const price of [1,150,2802,60000]) for (const budget of [1,150,1000,5000,1000000,Number.MAX_SAFE_INTEGER]) {
    const quantity=quantityForBudget(budget,price,unit),amount=quantity*price;
    assert.equal(quantity%unit,0); assert.ok(quantity<=100000);
    if(quantity) assert.ok(amount+feeFor(amount)<=budget);
    if(quantity+unit<=100000) assert.ok((quantity+unit)*price+feeFor((quantity+unit)*price)>budget);
  }
  assert.equal(quantityForBudget(5000,2802),1);
  assert.equal(quantityForBudget(5000,2802,100),0);
  for(const budget of [0,-1,1.5,'1000',Infinity]) assert.equal(quantityForBudget(budget,150),0);
  assert.equal(quantityForBudget(1000,0),0); assert.equal(quantityForBudget(1000,150,2),0);
});
test('budget purchases and profitable sales change the bank balance by the net realized profit', () => {
  const market=frozenMarket(),initialBalance=10000,budget=5000,buyPrice=bookFor(market.quotes['7203']).ask;
  const quantity=quantityForBudget(budget,buyPrice);
  const bought=placeOrder(emptyPortfolio(),request(market,{budget,quantity}),market,initialBalance,'budget-buy',1);
  assert.equal(bought.order.status,'filled'); assert.equal(bought.order.budget,budget);
  const buyCost=buyPrice*quantity+feeFor(buyPrice*quantity);
  assert.equal(bought.balance,initialBalance-buyCost); assert.ok(buyCost<=budget);
  const later=structuredClone(market); later.quotes['7203'].price=3200;
  const sellPrice=bookFor(later.quotes['7203']).bid;
  const sold=placeOrder(bought.state,request(later,{side:'sell',quantity,expectedPrice:sellPrice}),later,bought.balance,'profitable-sell',2);
  const profit=sellPrice*quantity-feeFor(sellPrice*quantity)-buyCost;
  assert.ok(profit>0); assert.equal(sold.state.realized,profit); assert.equal(sold.order.profit,profit);
  assert.equal(sold.balance,initialBalance+profit); assert.deepEqual(sold.state.holdings['7203'],{quantity:0,cost:0});
  for (const budget of [0,-1,1.5,'5000',Infinity]) assert.throws(()=>placeOrder(emptyPortfolio(),request(market,{budget}),market,initialBalance,'bad'));
  assert.throws(()=>placeOrder(emptyPortfolio(),request(market,{budget:5000,quantity:2}),market,initialBalance,'overspend'),/投資金額/);
  assert.throws(()=>placeOrder(bought.state,request(market,{side:'sell',budget,quantity,expectedPrice:bookFor(market.quotes['7203']).bid}),market,bought.balance,'sell-budget'),/買付時/);
  const reserved=placeOrder(emptyPortfolio(),request(market,{type:'limit',limitPrice:2790,quantity:3,budget:10000}),market,initialBalance,'reserved');
  assert.throws(()=>placeOrder(reserved.state,request(market,{budget,quantity}),market,reserved.balance,'cannot-reuse'),/不足/);
});
test('market candles stay coherent and within daily price limits across days', () => {
  let seed=37; const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  let market=createMarket(0,random);
  assert.equal(advanceMarket(market,2000,random),market);
  for(let i=1;i<=680;i++) {
    market=advanceMarket(market,i*3000,random); assert.ok(validMarket(market));
    for(const q of Object.values(market.quotes)) { const bounds=limitsFor(q); assert.ok(q.price>=bounds.low&&q.price<=bounds.high); }
  }
  assert.ok(market.day>=3); assert.equal(market.quotes['7203'].candles.length,90);
  assert.equal(priceLimit(999),150); assert.equal(priceLimit(1000),300); assert.equal(priceLimit(3000),700);
  assert.ok(new Set(Object.values(market.quotes).map(q=>q.price/q.previousClose)).size>1);
});
test('buy and sell use opposite quotes; fees affect cost and realized profit', () => {
  const m=frozenMarket(),book=bookFor(m.quotes['7203']);
  const bought=placeOrder(emptyPortfolio(),request(m),m,20000,'buy',1);
  const cost=book.ask*2+feeFor(book.ask*2); assert.equal(bought.balance,20000-cost); assert.equal(bought.state.holdings['7203'].cost,cost);
  const sold=placeOrder(bought.state,request(m,{side:'sell',quantity:1,expectedPrice:book.bid}),m,bought.balance,'sell',2);
  assert.equal(sold.state.holdings['7203'].quantity,1);
  assert.equal(sold.state.realized,book.bid-feeFor(book.bid)-Math.floor(cost/2));
  assert.equal(bought.state.holdings['7203'].quantity,2); assert.ok(validPortfolio(sold.state));
});
test('orders respect lots, ranges, available cash, per-symbol shares and quote changes', () => {
  const m=frozenMarket();
  for(const patch of [{unit:100,quantity:1},{quantity:0},{symbol:'fake'},{quantity:100001},{type:'limit',limitPrice:1},{expectedPrice:1},{quantity:Infinity},{side:'other'}]) assert.throws(()=>placeOrder(emptyPortfolio(),request(m,patch),m,20000,'bad'));
  assert.throws(()=>placeOrder(emptyPortfolio(),request(m),m,1,'bad'),/不足/);
  const bought=placeOrder(emptyPortfolio(),request(m),m,20000,'buy');
  assert.throws(()=>placeOrder(bought.state,request(m,{side:'sell',symbol:'6758',expectedPrice:bookFor(m.quotes['6758']).bid}),m,bought.balance,'bad'),/不足/);
  assert.throws(()=>placeOrder(bought.state,request(m,{side:'sell',quantity:3,expectedPrice:bookFor(m.quotes['7203']).bid}),m,bought.balance,'bad'),/不足/);
});
test('limit orders reserve cash/shares, fill at better quotes and can be cancelled or expire', () => {
  const m=frozenMarket(),limit=m.quotes['7203'].price-10;
  const pending=placeOrder(emptyPortfolio(),request(m,{type:'limit',limitPrice:limit}),m,20000,'limit');
  assert.equal(pending.balance,20000); assert.equal(pending.order.status,'open'); assert.equal(reservedCash(pending.state),limit*2+feeFor(limit*2));
  assert.throws(()=>placeOrder(pending.state,request(m,{quantity:6}),m,pending.balance,'too-much'),/不足/);
  const later=structuredClone(m);later.quotes['7203'].price=limit-5;
  const filled=settleOrders(pending.state,later,pending.balance,3);
  assert.equal(filled.fills.length,1); assert.ok(filled.fills[0].price<=limit);assert.equal(reservedCash(filled.state),0);
  const selling=placeOrder(filled.state,request(m,{side:'sell',type:'limit',limitPrice:m.quotes['7203'].price+10}),m,filled.balance,'sell-pending');
  assert.equal(reservedShares(selling.state,'7203'),2);
  assert.throws(()=>placeOrder(selling.state,request(m,{side:'sell',quantity:1,expectedPrice:bookFor(m.quotes['7203']).bid}),m,selling.balance,'oversell'),/不足/);
  assert.equal(reservedShares(cancelOrder(selling.state,'sell-pending'),'7203'),0);
  const expired=settleOrders(pending.state,{...m,day:m.day+1},pending.balance);assert.equal(expired.state.orders[0].status,'expired');assert.equal(expired.balance,pending.balance);assert.equal(reservedCash(expired.state),0);
});
test('no opposite quote is available at a simulated limit', () => {
  const m=frozenMarket();m.quotes['7203'].price=limitsFor(m.quotes['7203']).high;
  assert.equal(bookFor(m.quotes['7203']).ask,null);assert.throws(()=>placeOrder(emptyPortfolio(),request(m),m,20000,'bad'));
  const limit=placeOrder(emptyPortfolio(),request(m,{type:'limit',limitPrice:m.quotes['7203'].price}),m,20000,'wait');assert.equal(limit.order.status,'open');
});
