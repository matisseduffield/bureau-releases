// Bureau's pure logic: number parsing, sums, formatting options, rate merging
// and reading the rate sources. No DOM and no app state, so the same file runs in the page and
// under `node --test tests/` in CI.
(function (root) {
  // The most traded coins, in market order; Coinbase quotes them all live, and
  // the daily rate file has them for when it can't.
  const CRYPTO = {
    BTC: 'Bitcoin', ETH: 'Ethereum', USDT: 'Tether', XRP: 'XRP', BNB: 'BNB',
    SOL: 'Solana', USDC: 'USD Coin', DOGE: 'Dogecoin', ADA: 'Cardano', LTC: 'Litecoin',
  };

  function fractionDigits(code) {
    if (CRYPTO[code]) return 8;
    try { return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits; }
    catch { return 2; }
  }

  // Decimals for a coin worth `usdPrice`: enough to show about a cent, so a
  // stablecoin reads 327.49 and Bitcoin 0.0012834 (2 to 8 places).
  function cryptoDigits(usdPrice) {
    if (!(usdPrice > 0)) return 6;
    return Math.min(8, Math.max(2, Math.ceil(Math.log10(usdPrice)) + 2));
  }

  // Currency's own decimals; only amounts that would round to zero get significant digits.
  function amountOpts(n, code, usdPrice) {
    const abs = Math.abs(n);
    if (CRYPTO[code]) return abs >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: cryptoDigits(usdPrice) } : { maximumSignificantDigits: 6 };
    const d = fractionDigits(code);
    if (abs > 0 && abs < Math.pow(10, -d) * 5) return { maximumSignificantDigits: 3 };
    return { minimumFractionDigits: d, maximumFractionDigits: d };
  }

  // One number as typed: either "." or "," can be the decimal point. When both
  // appear the last one is; a lone separator is grouping only when it's the
  // locale's group mark followed by exactly three digits ("1.500" in Germany).
  function parseNumber(s, group) {
    s = s.replace(/['’]/g, '');
    if (!s) return NaN;
    const hasDot = s.includes('.'), hasComma = s.includes(',');
    if (hasDot && hasComma) {
      const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
    } else if (hasDot || hasComma) {
      const ch = hasDot ? '.' : ',';
      const parts = s.split(ch);
      // Grouping needs every group three digits after something other than a bare 0,
      // and a lone mark must be the locale's: "1.234.567" anywhere, "1.500" in Germany,
      // but "0.500" is a half and "1.5." is a typo, not 15.
      const threes = /^\d*[1-9]\d*$/.test(parts[0]) && parts.slice(1).every(p => p.length === 3);
      if (threes && (parts.length > 2 || ch === group)) s = parts.join('');
      else if (parts.length > 2) return NaN;
      else s = (parts[0] || '0') + '.' + parts[1];
    }
    return /^\d*\.?\d+$|^\d+\.$/.test(s) ? parseFloat(s) : NaN;
  }

  // Amount fields accept simple sums such as 12*3.5 or (40+25)/2. Hand-parsed; nothing is eval'd.
  function evaluate(text, group) {
    // A pasted amount may carry its currency: "$12.50", "12.50 USD", "€ 1.234,56".
    const bare = String(text).trim().replace(/^[A-Za-z]{1,3}(?=[\s\d.,\p{Sc}])|(?<=[\s\d.,\p{Sc}])[A-Za-z]{2,3}$/gu, '').replace(/\p{Sc}/gu, '');
    const src = bare.replace(/[\s  ]/g, '').replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-');
    if (!src) return { value: NaN, isExpr: false };
    const tokens = src.match(/[0-9.,'’]+|[-+*/()]/g);
    if (!tokens || tokens.join('') !== src) return { value: NaN, isExpr: false };
    let i = 0;
    const peek = () => tokens[i];
    function factor() {
      const t = tokens[i++];
      if (t === '-') return -factor();
      if (t === '+') return factor();
      if (t === '(') { const v = expr(); if (tokens[i++] !== ')') return NaN; return v; }
      return t === undefined ? NaN : parseNumber(t, group);
    }
    function term() {
      let v = factor();
      while (peek() === '*' || peek() === '/') { const op = tokens[i++]; const r = factor(); v = op === '*' ? v * r : v / r; }
      return v;
    }
    function expr() {
      let v = term();
      while (peek() === '+' || peek() === '-') { const op = tokens[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
      return v;
    }
    const value = expr();
    const isExpr = tokens.length > 1;
    return { value: i === tokens.length && Number.isFinite(value) ? value : NaN, isExpr };
  }

  // Coinbase's live rate wins unless it's more than 10% away from the daily
  // reference: its quotes for thinly traded currencies (and tickers that clash
  // with old currency codes) can be far off. Rates are units per 1 USD.
  function mergeRates(live, ref, isFiat) {
    const out = {};
    if (ref) for (const [k, v] of Object.entries(ref)) if (isFiat(k) && v > 0) out[k] = v;
    if (live) {
      for (const [k, v] of Object.entries(live)) {
        if (CRYPTO[k]) { out[k] = v; continue; }
        if (!isFiat(k)) continue;
        if (ref && ref[k] > 0 && Math.abs(v / ref[k] - 1) > 0.1) continue;
        out[k] = v;
      }
    }
    return out;
  }

  // A refresh that reached Coinbase: the merged rates, split the way the page
  // keeps them. Live rates carry no time of their own, so they date from now.
  // A currency Coinbase lacks, or whose quote was set aside, has the daily rate
  // instead; `dated` gives each of those the daily rate's own time, `refAt`.
  function liveRates(live, ref, isFiat, now, refAt) {
    const fiat = {}, coins = {}, dated = {};
    for (const [k, v] of Object.entries(mergeRates(live, ref, isFiat))) {
      (CRYPTO[k] ? coins : fiat)[k] = v;
      if (!CRYPTO[k] && !(live && live[k] === v) && refAt > 0) dated[k] = refAt;
    }
    return { fiat, coins, fiatAt: now, coinAt: now, dated };
  }

  // The daily file's figures for these are far from ExchangeRate-API's (SYP by
  // about 100 times, ZWL by far more), so a fallback shows no rate for them
  // rather than a wrong one. Keep in step with Rates.kt.
  const FILE_SKIP = new Set(['SDG', 'SYP', 'ZWL']);

  // ExchangeRate-API's answer: national currencies, units per 1 USD, with the
  // time it was published. Null if it isn't usable.
  function dailyRates(json, isFiat) {
    const updatedAt = json ? json.time_last_update_unix * 1000 : NaN;
    if (!json || json.result !== 'success' || !json.rates || !(json.rates.EUR > 0) || !(updatedAt > 0)) return null;
    const fiat = {};
    for (const [k, v] of Object.entries(json.rates)) if (isFiat(k) && v > 0) fiat[k] = v;
    return { fiat, updatedAt };
  }

  // The fawazahmed0 file: lowercase codes, currencies and coins together, and
  // a date rather than a time. A coin it leaves out stays out.
  function fileRates(json, isFiat) {
    const usd = json && json.usd;
    const updatedAt = json ? Date.parse(json.date + 'T00:00:00Z') : NaN;
    if (!usd || !(usd.eur > 0) || !(updatedAt > 0)) return null;
    const fiat = { USD: 1 }, coins = {};
    for (const [k, v] of Object.entries(usd)) {
      if (!(v > 0)) continue;
      const code = k.toUpperCase();
      if (CRYPTO[code]) coins[code] = v;
      else if (isFiat(code) && !FILE_SKIP.has(code)) fiat[code] = v;
    }
    return { fiat, coins, updatedAt };
  }

  // What a refresh leaves us without Coinbase. `saved` is { fiat, coins, fiatAt, coinAt };
  // `daily` and `file` are what came back, or null. Each half keeps the date
  // of its own source, and is only replaced by something at least as new. A
  // new file replaces all the coins, so one it no longer has isn't kept.
  // Saved live rates keep their `dated` exceptions; daily ones need none.
  function combineRates(saved, daily, file) {
    const out = { fiat: saved.fiat, coins: saved.coins, fiatAt: saved.fiatAt || 0, coinAt: saved.coinAt || 0, dated: saved.dated || {} };
    const fiat = [daily, file].find(s => s && s.updatedAt >= out.fiatAt);
    if (fiat) Object.assign(out, { fiat: fiat.fiat, fiatAt: fiat.updatedAt, dated: {} });
    if (file && file.updatedAt >= out.coinAt) Object.assign(out, { coins: file.coins, coinAt: file.updatedAt });
    return { ...out, offline: !daily && !file };
  }

  // When a pair's rate dates from: the older of its two sides. USD is always 1.
  function pairUpdatedAt(from, to, fiatAt, coinAt, dated) {
    const at = code => (code === 'USD' ? Infinity : dated && dated[code] ? dated[code] : CRYPTO[code] ? coinAt : fiatAt);
    return Math.min(at(from), at(to));
  }

  // What the status line says about the rates in use, and the time it gives.
  // `s` is the page's state; `priced` is whether the pair has a rate. "live"
  // needs both sides quoted by Coinbase in the last ten minutes; a side on its
  // daily rate makes it "dailyPair", dated by that rate. `byDay` is set when
  // the time is a daily rate's, which goes by its date rather than the clock.
  function rateStatus(s, priced, now) {
    const at = priced ? pairUpdatedAt(s.from, s.to, s.fiatAt, s.coinAt, s.dated) : s.fiatAt;
    const live = s.source === 'live';
    const onDaily = priced && live && !!s.dated && [s.from, s.to].some(c => s.dated[c] > 0);
    const byDay = !live || onDaily;
    const kind = s.error ? 'offline' : !live ? 'daily' : onDaily ? 'dailyPair' : now - at > 10 * 60_000 ? 'stale' : 'live';
    return { kind, at, byDay };
  }

  // Countries that use each currency (ISO 4217 code: ISO 3166 regions, two
  // letters each), from the datasets/country-codes table. Lets the picker
  // find a currency by country: "Thailand" finds THB.
  const REGIONS = (
    'AED:AE AFN:AF ALL:AL AMD:AM AOA:AO ARS:AR AUD:AUCCCXHMKINFNRTV AWG:AW AZN:AZ BAM:BA BBD:BB ' +
    'BDT:BD BHD:BH BIF:BI BMD:BM BND:BN BOB:BO BRL:BR BSD:BS BTN:BT BWP:BW BYN:BY BZD:BZ CAD:CA ' +
    'CDF:CD CHF:CHLI CLP:CL CNY:CN COP:CO CRC:CR CUP:CU CVE:CV CZK:CZ DJF:DJ DKK:DKFOGL DOP:DO DZD:DZ ' +
    'EGP:EG ERN:ER ETB:ET ' +
    'EUR:ADATAXBEBGBLCYDEEEESFIFRGFGPGRHRIEITLTLULVMCMEMFMQMTNLPMPTRESISKSMTFVAYT FJD:FJ FKP:FK ' +
    'GBP:GBGGIMJE GEL:GE GHS:GH GIP:GI GMD:GM GNF:GN GTQ:GT GYD:GY HKD:HK HNL:HN HTG:HT HUF:HU IDR:ID ' +
    'ILS:IL INR:BTIN IQD:IQ IRR:IR ISK:IS JMD:JM JOD:JO JPY:JP KES:KE KGS:KG KHR:KH KMF:KM KPW:KP ' +
    'KRW:KR KWD:KW KYD:KY KZT:KZ LAK:LA LBP:LB LKR:LK LRD:LR LSL:LS LYD:LY MAD:EHMA MDL:MD MGA:MG ' +
    'MKD:MK MMK:MM MNT:MN MOP:MO MRU:MR MUR:MU MVR:MV MWK:MW MXN:MX MYR:MY MZN:MZ NAD:NA NGN:NG ' +
    'NIO:NI NOK:BVNOSJ NPR:NP NZD:CKNUNZPNTK OMR:OM PAB:PA PEN:PE PGK:PG PHP:PH PKR:PK PLN:PL PYG:PY ' +
    'QAR:QA RON:RO RSD:RS RUB:RU RWF:RW SAR:SA SBD:SB SCR:SC SDG:SD SEK:SE SGD:SG SHP:SH SLE:SL ' +
    'SOS:SO SRD:SR SSP:SS STN:ST SVC:SV SYP:SY SZL:SZ THB:TH TJS:TJ TMT:TM TND:TN TOP:TO TRY:TR ' +
    'TTD:TT TWD:TW TZS:TZ UAH:UA UGX:UG USD:ASBQECFMGUHTIOMHMPPAPRPWSVTCTLUMUSVGVI UYU:UY UZS:UZ ' +
    'VED:VE VES:VE VND:VN VUV:VU WST:WS XAF:CFCGCMGAGQTD XCD:AGAIDMGDKNLCMSVC XCG:CWSX ' +
    'XOF:BFBJCIGWMLNESNTG XPF:NCPFWF YER:YE ZAR:LSNAZA ZMW:ZM ZWG:ZW'
  );
  const regionTable = {};
  for (const part of REGIONS.split(' ')) {
    const [code, regs] = part.split(':');
    regionTable[code] = regs.match(/../g);
  }
  const regionsOf = code => regionTable[code] || [];

  // Everyday names people type that aren't the official country name.
  const REGION_ALIASES = {
    GB: ['UK', 'Britain', 'England', 'Scotland', 'Wales'],
    US: ['USA', 'America'],
    AE: ['UAE', 'Dubai', 'Abu Dhabi'],
    NL: ['Holland'],
    ID: ['Bali'],
    CZ: ['Czech Republic'],
  };

  // How well a search matches a currency: lower is better, null is no match.
  // `places` are country names for the currency; a country match carries
  // the name as a hint, unless the currency's own name already says it.
  function searchScore(query, code, name, places) {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const c = code.toLowerCase(), n = name.toLowerCase();
    const wordStart = text => text.toLowerCase().split(/[\s-]+/).some(w => w.startsWith(q));
    const hintFor = place => (n.includes(place.toLowerCase()) ? undefined : place);
    if (c === q) return { score: 0 };
    if (c.startsWith(q)) return { score: 1 };
    for (const place of places) if (place.toLowerCase() === q) return { score: 1.5, hint: hintFor(place) };
    if (n.startsWith(q)) return { score: 2 };
    for (const place of places) if (place.toLowerCase().startsWith(q)) return { score: 2.5, hint: hintFor(place) };
    if (wordStart(name)) return { score: 3 };
    for (const place of places) if (wordStart(place)) return { score: 3.5, hint: hintFor(place) };
    // Countries only match from the start of a word: "yen" shouldn't find Jan Mayen.
    if (n.includes(q)) return { score: 4 };
    return null;
  }

  // Days to sample for a trend drawn from daily snapshots (one file per day):
  // every day for a week, every other day for a month, fortnightly for a
  // year. Ends yesterday (UTC), the newest day with a complete file.
  function sampleDates(days, now) {
    const step = days <= 7 ? 1 : days <= 31 ? 2 : 14;
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 864e5;
    const out = [];
    for (let back = days - (days % step); back >= 0; back -= step) {
      out.push(new Date(end - back * 864e5).toISOString().slice(0, 10));
    }
    return out;
  }

  // [date, rate] pairs from per-day snapshots of units per 1 USD (lowercase
  // codes, as the snapshot files use). Days missing either currency are skipped.
  function crossSeries(dates, snapshots, from, to) {
    const out = [];
    const per = (usd, code) => (code === 'USD' ? 1 : usd[code.toLowerCase()]);
    dates.forEach((date, i) => {
      const usd = snapshots[i] && snapshots[i].usd;
      if (!usd) return;
      const a = per(usd, from), b = per(usd, to);
      if (a > 0 && b > 0) out.push([date, b / a]);
    });
    return out;
  }

  const lib = { CRYPTO, fractionDigits, cryptoDigits, amountOpts, parseNumber, evaluate, mergeRates, liveRates, dailyRates, fileRates, combineRates, pairUpdatedAt, rateStatus, regionsOf, REGION_ALIASES, searchScore, sampleDates, crossSeries };
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.BureauLib = lib;
})(this);
