import { Api } from "teleproto";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import axios, { AxiosError } from "axios";

import { htmlEscape } from "@utils/htmlEscape";

interface CoinGeckoResponse {
  [coinId: string]: {
    [key: string]: number;
  } & {
    last_updated_at?: number;
  };
}

// 内置法币映射表 - 全球190+国家和地区法币
const FIAT_CURRENCIES: Record<string, { symbol: string, name: string, aliases?: string[] }> = {
  // 主要发达国家
  'usd': { symbol: 'USD', name: 'US Dollar' },
  'eur': { symbol: 'EUR', name: 'Euro' },
  'gbp': { symbol: 'GBP', name: 'British Pound' },
  'jpy': { symbol: 'JPY', name: 'Japanese Yen' },
  'cny': { symbol: 'CNY', name: 'Chinese Yuan', aliases: ['rmb', 'yuan', 'cnh'] },
  'cad': { symbol: 'CAD', name: 'Canadian Dollar' },
  'aud': { symbol: 'AUD', name: 'Australian Dollar' },
  'chf': { symbol: 'CHF', name: 'Swiss Franc' },
  'nzd': { symbol: 'NZD', name: 'New Zealand Dollar' },
  
  // 北欧国家
  'sek': { symbol: 'SEK', name: 'Swedish Krona' },
  'nok': { symbol: 'NOK', name: 'Norwegian Krone' },
  'dkk': { symbol: 'DKK', name: 'Danish Krone' },
  'isk': { symbol: 'ISK', name: 'Icelandic Krona' },
  
  // 东欧国家
  'pln': { symbol: 'PLN', name: 'Polish Zloty' },
  'czk': { symbol: 'CZK', name: 'Czech Koruna' },
  'huf': { symbol: 'HUF', name: 'Hungarian Forint' },
  'ron': { symbol: 'RON', name: 'Romanian Leu' },
  'bgn': { symbol: 'BGN', name: 'Bulgarian Lev' },
  'hrk': { symbol: 'HRK', name: 'Croatian Kuna' },
  'rsd': { symbol: 'RSD', name: 'Serbian Dinar' },
  'bam': { symbol: 'BAM', name: 'Bosnia-Herzegovina Convertible Mark' },
  'mkd': { symbol: 'MKD', name: 'Macedonian Denar' },
  'all': { symbol: 'ALL', name: 'Albanian Lek' },
  'rub': { symbol: 'RUB', name: 'Russian Ruble' },
  'uah': { symbol: 'UAH', name: 'Ukrainian Hryvnia' },
  'byn': { symbol: 'BYN', name: 'Belarusian Ruble' },
  'mdl': { symbol: 'MDL', name: 'Moldovan Leu' },
  
  // 土耳其和高加索
  'try': { symbol: 'TRY', name: 'Turkish Lira' },
  'gel': { symbol: 'GEL', name: 'Georgian Lari' },
  'amd': { symbol: 'AMD', name: 'Armenian Dram' },
  'azn': { symbol: 'AZN', name: 'Azerbaijani Manat' },
  
  // 美洲
  'brl': { symbol: 'BRL', name: 'Brazilian Real' },
  'mxn': { symbol: 'MXN', name: 'Mexican Peso' },
  'ars': { symbol: 'ARS', name: 'Argentine Peso' },
  'cop': { symbol: 'COP', name: 'Colombian Peso' },
  'pen': { symbol: 'PEN', name: 'Peruvian Sol' },
  'clp': { symbol: 'CLP', name: 'Chilean Peso' },
  'uyu': { symbol: 'UYU', name: 'Uruguayan Peso' },
  'pyg': { symbol: 'PYG', name: 'Paraguayan Guarani' },
  'bob': { symbol: 'BOB', name: 'Bolivian Boliviano' },
  'ves': { symbol: 'VES', name: 'Venezuelan Bolívar' },
  'gyd': { symbol: 'GYD', name: 'Guyanese Dollar' },
  'srd': { symbol: 'SRD', name: 'Surinamese Dollar' },
  'ttd': { symbol: 'TTD', name: 'Trinidad and Tobago Dollar' },
  'jmd': { symbol: 'JMD', name: 'Jamaican Dollar' },
  'bbd': { symbol: 'BBD', name: 'Barbadian Dollar' },
  'bsd': { symbol: 'BSD', name: 'Bahamian Dollar' },
  'bzd': { symbol: 'BZD', name: 'Belize Dollar' },
  'crc': { symbol: 'CRC', name: 'Costa Rican Colón' },
  'gtq': { symbol: 'GTQ', name: 'Guatemalan Quetzal' },
  'hnl': { symbol: 'HNL', name: 'Honduran Lempira' },
  'nio': { symbol: 'NIO', name: 'Nicaraguan Córdoba' },
  'pab': { symbol: 'PAB', name: 'Panamanian Balboa' },
  'dop': { symbol: 'DOP', name: 'Dominican Peso' },
  'htg': { symbol: 'HTG', name: 'Haitian Gourde' },
  'cub': { symbol: 'CUP', name: 'Cuban Peso' },
  
  // 亚太地区
  'sgd': { symbol: 'SGD', name: 'Singapore Dollar' },
  'hkd': { symbol: 'HKD', name: 'Hong Kong Dollar' },
  'krw': { symbol: 'KRW', name: 'South Korean Won' },
  'inr': { symbol: 'INR', name: 'Indian Rupee' },
  'thb': { symbol: 'THB', name: 'Thai Baht' },
  'myr': { symbol: 'MYR', name: 'Malaysian Ringgit' },
  'php': { symbol: 'PHP', name: 'Philippine Peso' },
  'idr': { symbol: 'IDR', name: 'Indonesian Rupiah' },
  'vnd': { symbol: 'VND', name: 'Vietnamese Dong' },
  'lak': { symbol: 'LAK', name: 'Lao Kip' },
  'khr': { symbol: 'KHR', name: 'Cambodian Riel' },
  'mmk': { symbol: 'MMK', name: 'Myanmar Kyat' },
  'bnd': { symbol: 'BND', name: 'Brunei Dollar' },
  'twd': { symbol: 'TWD', name: 'Taiwan Dollar' },
  'mop': { symbol: 'MOP', name: 'Macanese Pataca' },
  'fjd': { symbol: 'FJD', name: 'Fijian Dollar' },
  'pgk': { symbol: 'PGK', name: 'Papua New Guinea Kina' },
  'sbd': { symbol: 'SBD', name: 'Solomon Islands Dollar' },
  'vuv': { symbol: 'VUV', name: 'Vanuatu Vatu' },
  'top': { symbol: 'TOP', name: 'Tongan Paʻanga' },
  'wst': { symbol: 'WST', name: 'Samoan Tala' },
  
  // 南亚
  'lkr': { symbol: 'LKR', name: 'Sri Lankan Rupee' },
  'pkr': { symbol: 'PKR', name: 'Pakistani Rupee' },
  'bdt': { symbol: 'BDT', name: 'Bangladeshi Taka' },
  'npr': { symbol: 'NPR', name: 'Nepalese Rupee' },
  'btn': { symbol: 'BTN', name: 'Bhutanese Ngultrum' },
  'mvr': { symbol: 'MVR', name: 'Maldivian Rufiyaa' },
  'afn': { symbol: 'AFN', name: 'Afghan Afghani' },
  
  // 中亚
  'kzt': { symbol: 'KZT', name: 'Kazakhstani Tenge' },
  'uzs': { symbol: 'UZS', name: 'Uzbekistani Som' },
  'kgs': { symbol: 'KGS', name: 'Kyrgyzstani Som' },
  'tjs': { symbol: 'TJS', name: 'Tajikistani Somoni' },
  'tmm': { symbol: 'TMT', name: 'Turkmenistani Manat' },
  
  // 中东
  'zar': { symbol: 'ZAR', name: 'South African Rand' },
  'ils': { symbol: 'ILS', name: 'Israeli Shekel' },
  'aed': { symbol: 'AED', name: 'UAE Dirham' },
  'sar': { symbol: 'SAR', name: 'Saudi Riyal' },
  'qar': { symbol: 'QAR', name: 'Qatari Riyal' },
  'kwd': { symbol: 'KWD', name: 'Kuwaiti Dinar' },
  'bhd': { symbol: 'BHD', name: 'Bahraini Dinar' },
  'omr': { symbol: 'OMR', name: 'Omani Rial' },
  'jod': { symbol: 'JOD', name: 'Jordanian Dinar' },
  'lbp': { symbol: 'LBP', name: 'Lebanese Pound' },
  'syp': { symbol: 'SYP', name: 'Syrian Pound' },
  'iqd': { symbol: 'IQD', name: 'Iraqi Dinar' },
  'irr': { symbol: 'IRR', name: 'Iranian Rial' },
  'yer': { symbol: 'YER', name: 'Yemeni Rial' },
  
  // 非洲北部
  'egp': { symbol: 'EGP', name: 'Egyptian Pound' },
  'mad': { symbol: 'MAD', name: 'Moroccan Dirham' },
  'dzd': { symbol: 'DZD', name: 'Algerian Dinar' },
  'tnd': { symbol: 'TND', name: 'Tunisian Dinar' },
  'lyd': { symbol: 'LYD', name: 'Libyan Dinar' },
  'sdg': { symbol: 'SDG', name: 'Sudanese Pound' },
  'etb': { symbol: 'ETB', name: 'Ethiopian Birr' },
  'ern': { symbol: 'ERN', name: 'Eritrean Nakfa' },
  'djf': { symbol: 'DJF', name: 'Djiboutian Franc' },
  'sos': { symbol: 'SOS', name: 'Somali Shilling' },
  
  // 非洲西部
  'ngn': { symbol: 'NGN', name: 'Nigerian Naira' },
  'ghs': { symbol: 'GHS', name: 'Ghanaian Cedi' },
  'xof': { symbol: 'XOF', name: 'West African CFA Franc' },
  'sll': { symbol: 'SLL', name: 'Sierra Leonean Leone' },
  'lrd': { symbol: 'LRD', name: 'Liberian Dollar' },
  'gmd': { symbol: 'GMD', name: 'Gambian Dalasi' },
  'gnf': { symbol: 'GNF', name: 'Guinean Franc' },
  'cvs': { symbol: 'CVE', name: 'Cape Verdean Escudo' },
  
  // 非洲东部
  'kes': { symbol: 'KES', name: 'Kenyan Shilling' },
  'ugx': { symbol: 'UGX', name: 'Ugandan Shilling' },
  'tzs': { symbol: 'TZS', name: 'Tanzanian Shilling' },
  'rwf': { symbol: 'RWF', name: 'Rwandan Franc' },
  'bif': { symbol: 'BIF', name: 'Burundian Franc' },
  'mzn': { symbol: 'MZN', name: 'Mozambican Metical' },
  'mwk': { symbol: 'MWK', name: 'Malawian Kwacha' },
  'zmw': { symbol: 'ZMW', name: 'Zambian Kwacha' },
  'zwd': { symbol: 'ZWL', name: 'Zimbabwean Dollar' },
  'mga': { symbol: 'MGA', name: 'Malagasy Ariary' },
  'mur': { symbol: 'MUR', name: 'Mauritian Rupee' },
  'scr': { symbol: 'SCR', name: 'Seychellois Rupee' },
  'kmf': { symbol: 'KMF', name: 'Comorian Franc' },
  
  // 非洲中部
  'xaf': { symbol: 'XAF', name: 'Central African CFA Franc' },
  'cdf': { symbol: 'CDF', name: 'Congolese Franc' },
  'aoa': { symbol: 'AOA', name: 'Angolan Kwanza' },
  'std': { symbol: 'STN', name: 'São Tomé and Príncipe Dobra' },
  'gqe': { symbol: 'XAF', name: 'Equatorial Guinea CFA Franc' },
  
  // 非洲南部
  'bwp': { symbol: 'BWP', name: 'Botswana Pula' },
  'nad': { symbol: 'NAD', name: 'Namibian Dollar' },
  'szl': { symbol: 'SZL', name: 'Swazi Lilangeni' },
  'lsl': { symbol: 'LSL', name: 'Lesotho Loti' }
};

// 内置加密货币映射表 - 前30名主流加密货币
const CRYPTO_CURRENCIES: Record<string, { symbol: string, name: string, aliases?: string[] }> = {
  'btc': { symbol: 'BTC', name: 'Bitcoin', aliases: ['bitcoin'] },
  'eth': { symbol: 'ETH', name: 'Ethereum', aliases: ['ethereum'] },
  'usdt': { symbol: 'USDT', name: 'Tether', aliases: ['tether'] },
  'bnb': { symbol: 'BNB', name: 'BNB', aliases: ['binancecoin'] },
  'sol': { symbol: 'SOL', name: 'Solana', aliases: ['solana'] },
  'usdc': { symbol: 'USDC', name: 'USD Coin', aliases: ['usd-coin'] },
  'xrp': { symbol: 'XRP', name: 'XRP', aliases: ['ripple'] },
  'doge': { symbol: 'DOGE', name: 'Dogecoin', aliases: ['dogecoin'] },
  'ton': { symbol: 'TON', name: 'Toncoin', aliases: ['toncoin'] },
  'ada': { symbol: 'ADA', name: 'Cardano', aliases: ['cardano'] },
  'shib': { symbol: 'SHIB', name: 'Shiba Inu', aliases: ['shiba-inu'] },
  'avax': { symbol: 'AVAX', name: 'Avalanche', aliases: ['avalanche-2'] },
  'trx': { symbol: 'TRX', name: 'TRON', aliases: ['tron'] },
  'dot': { symbol: 'DOT', name: 'Polkadot', aliases: ['polkadot'] },
  'link': { symbol: 'LINK', name: 'Chainlink', aliases: ['chainlink'] },
  'matic': { symbol: 'MATIC', name: 'Polygon', aliases: ['matic-network'] },
  'wbtc': { symbol: 'WBTC', name: 'Wrapped Bitcoin', aliases: ['wrapped-bitcoin'] },
  'ltc': { symbol: 'LTC', name: 'Litecoin', aliases: ['litecoin'] },
  'bch': { symbol: 'BCH', name: 'Bitcoin Cash', aliases: ['bitcoin-cash'] },
  'uni': { symbol: 'UNI', name: 'Uniswap', aliases: ['uniswap'] },
  'atom': { symbol: 'ATOM', name: 'Cosmos', aliases: ['cosmos'] },
  'etc': { symbol: 'ETC', name: 'Ethereum Classic', aliases: ['ethereum-classic'] },
  'xlm': { symbol: 'XLM', name: 'Stellar', aliases: ['stellar'] },
  'okb': { symbol: 'OKB', name: 'OKB' },
  'icp': { symbol: 'ICP', name: 'Internet Computer', aliases: ['internet-computer'] },
  'fil': { symbol: 'FIL', name: 'Filecoin', aliases: ['filecoin'] },
  'hbar': { symbol: 'HBAR', name: 'Hedera', aliases: ['hedera-hashgraph'] },
  'ldo': { symbol: 'LDO', name: 'Lido DAO', aliases: ['lido-dao'] },
  'crv': { symbol: 'CRV', name: 'Curve DAO Token', aliases: ['curve-dao-token'] },
  'arb': { symbol: 'ARB', name: 'Arbitrum', aliases: ['arbitrum'] }
};

// HTML转义工具
const codeTag = (text: string): string => `<code>${htmlEscape(text)}</code>`;

const help_text = `🚀 <b>智能汇率查询助手</b>

📊 <b>使用示例</b>
• <code>rate BTC</code> - 比特币美元价
• <code>rate ETH CNY</code> - 以太坊人民币价
• <code>rate CNY TRY</code> - 人民币兑土耳其里拉
• <code>rate BTC CNY 0.5</code> - 0.5个BTC换算
• <code>rate CNY USDT 7000</code> - 7000元换USDT`;

class RatePlugin extends Plugin {

  description: string = `加密货币汇率查询 & 数量换算\n\n${help_text}`;

  // 货币缓存 - 提高性能，避免重复API调用
  private currencyCache: Record<string, {id: string, symbol: string, name: string, type: 'crypto' | 'fiat'}> = {};
  // 支持的法币集（从 CoinGecko 动态获取并缓存）
  private vsFiats: Set<string> | null = null;
  private vsFiatsTs: number = 0;
  // 法币汇率缓存（按基准币种缓存一篮子）
  private fiatRatesCache: Record<string, { rates: Record<string, number>, ts: number }> = {};
  
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    rate: async (msg: Api.Message) => {
      await this.handleRate(msg);
    }
  };

  // 规范化货币代码（别名归一）
  private normalizeCode(s: string | undefined): string {
    const k = (s || '').toLowerCase();

    if (k === 'rm') {
      return 'myr';
    }
    
    // 检查法币别名
    for (const [code, info] of Object.entries(FIAT_CURRENCIES)) {
      if (info.aliases?.includes(k)) {
        return code;
      }
    }
    
    // 检查加密货币别名
    for (const [code, info] of Object.entries(CRYPTO_CURRENCIES)) {
      if (info.aliases?.includes(k)) {
        return code;
      }
    }
    
    return k;
  }

  // 获取法币汇率（带多源回退与5分钟缓存）
  private async fetchFiatRates(base: string): Promise<Record<string, number>> {
    const key = base.toLowerCase();
    const now = Date.now();
    const cached = this.fiatRatesCache[key];
    if (cached && now - cached.ts < 5 * 60 * 1000) return cached.rates;
    const endpoints = [
      `https://api.exchangerate.host/latest?base=${encodeURIComponent(key)}`,
      `https://open.er-api.com/v6/latest/${encodeURIComponent(key)}`,
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(key)}`,
      // AllRatesToday 公开 ECB 汇率表（无钥，返回 { result: 'success', rates: {...} }）
      `https://allratestoday.com/api/open/latest/${encodeURIComponent(key)}`,
      // Coinbase 公共汇率（含法币与加密货币）
      `https://api.coinbase.com/v2/exchange-rates?currency=${encodeURIComponent(key.toUpperCase())}`,
      // jsDelivr 镜像的每日更新静态汇率（无钥，稳定）
      `https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/latest/currencies/${encodeURIComponent(key.toLowerCase())}.json`
    ];
    for (const url of endpoints) {
      try {
        const { data } = await axios.get(url, { timeout: 8000 });
        let rates: Record<string, number> | null = null;
        // 标准结构与 open.er-api、frankfurter、allratestoday
        if (data?.rates) rates = data.rates;
        if (data?.result === 'success' && data?.rates) rates = data.rates;
        // Coinbase 结构: { data: { rates: { USD: "1", ... } } }
        if (!rates && data?.data?.rates) rates = data.data.rates;
        // Fawaz Ahmed currency API: { date: '...', usd: { eur: 0.93, ... } }
        if (!rates && typeof data === 'object' && data && data[key]) rates = data[key];
        if (rates) {
          const normalized = Object.fromEntries(
            Object.entries(rates).map(([k, v]) => [k.toLowerCase(), Number(v)])
          );
          this.fiatRatesCache[key] = { rates: normalized, ts: now };
          return normalized;
        }
      } catch {}
    }
    throw new Error('法币汇率服务不可用');
  }

  // 智能解析参数：抓取两种货币与数量（数量可在任意位置）
  private parseArgs(args: string[]): { base: string, quote: string, amount: number } {
    const tokens = (args || []).map(a => this.normalizeCode(a));
    let amount = 1;
    const curr: string[] = [];
    for (const t of tokens) {
      const n = parseFloat(t);
      if (!isNaN(n) && isFinite(n)) amount = n; else curr.push(t);
    }
    const base = curr[0] || 'btc';
    const quote = curr[1] || 'usd';
    return { base, quote, amount };
  }

  // (新) 获取币安价格
  private async fetchBinancePrice(symbol: string): Promise<number> {
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`;
      const { data } = await axios.get(url, { timeout: 5000 });
      if (data && data.price) {
        return parseFloat(data.price);
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 400) {
        // 交易对不存在，这不是一个严重错误，静默处理
      } else {
        console.warn(`[RatePlugin] Binance API for ${symbol} failed:`, error);
      }
    }
    throw new Error(`Binance pair not found for ${symbol}`);
  }

  // (全智能) 获取任意两种货币之间的汇率
  private async getUniversalPrice(symbol1: string, symbol2: string, type1: 'crypto' | 'fiat', type2: 'crypto' | 'fiat'): Promise<{ price: number, lastUpdated: Date }> {
    const s1 = symbol1.toUpperCase();
    const s2 = symbol2.toUpperCase();

    // 情况1: 加密货币 -> 加密货币
    if (type1 === 'crypto' && type2 === 'crypto') {
      return await this.getCryptoCryptoPrice(s1, s2);
    }
    
    // 情况2: 加密货币 -> 法币
    if (type1 === 'crypto' && type2 === 'fiat') {
      return await this.getCryptoFiatPrice(s1, s2);
    }
    
    // 情况3: 法币 -> 加密货币
    if (type1 === 'fiat' && type2 === 'crypto') {
      try {
        const cryptoToFiat = await this.getCryptoFiatPrice(s2, s1);
        return { price: 1 / cryptoToFiat.price, lastUpdated: cryptoToFiat.lastUpdated };
      } catch (error) {
        throw new Error(`无法获取 ${s2} 对 ${s1} 的价格来计算反向汇率`);
      }
    }
    
    // 情况4: 法币 -> 法币
    if (type1 === 'fiat' && type2 === 'fiat') {
      const rates = await this.fetchFiatRates(s1.toLowerCase());
      const rate = rates[s2.toLowerCase()];
      if (!rate) throw new Error(`无法获取 ${s1} 到 ${s2} 的汇率`);
      return { price: rate, lastUpdated: new Date() };
    }

    throw new Error(`不支持的货币类型组合: ${type1} -> ${type2}`);
  }

  // 加密货币对加密货币
  private async getCryptoCryptoPrice(crypto1: string, crypto2: string): Promise<{ price: number, lastUpdated: Date }> {
    // 1. 直接交易对
    try {
      const price = await this.fetchBinancePrice(`${crypto1}${crypto2}`);
      return { price, lastUpdated: new Date() };
    } catch {}

    try {
      const price = await this.fetchBinancePrice(`${crypto2}${crypto1}`);
      return { price: 1 / price, lastUpdated: new Date() };
    } catch {}

    // 2. 通过稳定币桥接
    const bridges = ['USDT', 'BUSD', 'USDC'];
    for (const bridge of bridges) {
      try {
        const price1 = await this.fetchBinancePrice(`${crypto1}${bridge}`);
        const price2 = await this.fetchBinancePrice(`${crypto2}${bridge}`);
        return { price: price1 / price2, lastUpdated: new Date() };
      } catch {}
    }

    throw new Error(`无法找到 ${crypto1} 和 ${crypto2} 之间的交易对`);
  }

  // 加密货币对法币
  private async getCryptoFiatPrice(crypto: string, fiat: string): Promise<{ price: number, lastUpdated: Date }> {
    const bridges = ['USDT', 'BUSD', 'USDC'];
    let lastError: string = '';
    
    for (const bridge of bridges) {
      try {
        console.log(`[RatePlugin] 尝试通过 ${bridge} 桥接: ${crypto} -> ${fiat}`);
        
        // 获取加密货币对稳定币价格
        const cryptoPrice = await this.fetchBinancePrice(`${crypto}${bridge}`);
        console.log(`[RatePlugin] ${crypto}${bridge} 价格: ${cryptoPrice}`);
        
        // 如果目标就是稳定币
        if (fiat.toUpperCase() === bridge) {
          return { price: cryptoPrice, lastUpdated: new Date() };
        }
        
        // 获取稳定币对法币汇率 (1 USDT = 1 USD)
        let bridgeForFiat = bridge.toLowerCase();
        if (bridge === 'USDT' || bridge === 'BUSD' || bridge === 'USDC') {
          bridgeForFiat = 'usd';
        }
        
        console.log(`[RatePlugin] 获取 ${bridgeForFiat} 到 ${fiat} 的汇率`);
        const fiatRates = await this.fetchFiatRates(bridgeForFiat);
        const fiatRate = fiatRates[fiat.toLowerCase()];
        
        if (fiatRate) {
          const finalPrice = cryptoPrice * fiatRate;
          console.log(`[RatePlugin] 最终价格: ${crypto} = ${finalPrice} ${fiat}`);
          return { price: finalPrice, lastUpdated: new Date() };
        } else {
          lastError = `无法获取 ${bridgeForFiat} 到 ${fiat} 的汇率`;
        }
      } catch (error: any) {
        lastError = `${bridge} 桥接失败: ${error.message}`;
        console.warn(`[RatePlugin] ${lastError}`);
      }
    }

    throw new Error(`无法获取 ${crypto} 对 ${fiat} 的价格。最后错误: ${lastError}`);
  }

  // 动态判断是否为法币（优先使用网络列表，失败则回退本地列表）
  private async isFiat(query: string): Promise<boolean> {
    const now = Date.now();
    // 强制刷新法币列表以确保 TRY 被正确识别
    if (!this.vsFiats || now - this.vsFiatsTs > 6 * 60 * 60 * 1000 || query.toLowerCase() === 'try') {
      // 1) CoinGecko vs_currencies
      try {
        const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/supported_vs_currencies', { timeout: 8000 });
        this.vsFiats = new Set((data || []).map((x: string) => x.toLowerCase()));
        this.vsFiatsTs = now;
      } catch {}
      // 2) exchangerate.host /symbols
      if (!this.vsFiats || this.vsFiats.size === 0) {
        try {
          const { data } = await axios.get('https://api.exchangerate.host/symbols', { timeout: 8000 });
          const symbols = data?.symbols || {};
          this.vsFiats = new Set(Object.keys(symbols).map(k => k.toLowerCase()));
          this.vsFiatsTs = now;
        } catch {}
      }
      // 3) frankfurter.app /currencies
      if (!this.vsFiats || this.vsFiats.size === 0) {
        try {
          const { data } = await axios.get('https://api.frankfurter.app/currencies', { timeout: 8000 });
          this.vsFiats = new Set(Object.keys(data || {}).map(k => k.toLowerCase()));
          this.vsFiatsTs = now;
        } catch {}
      }
      // 4) allratestoday.com 公开 ECB 汇率表（取 rates 的键作为法币列表）
      if (!this.vsFiats || this.vsFiats.size === 0) {
        try {
          const { data } = await axios.get('https://allratestoday.com/api/open/latest/usd', { timeout: 8000 });
          this.vsFiats = new Set(Object.keys(data?.rates || {}).map(k => k.toLowerCase()));
          this.vsFiatsTs = now;
        } catch {}
      }
      // 最后兜底：使用常见法币列表（仅法币）
      if (!this.vsFiats || this.vsFiats.size === 0) {
        const commonFiats = ['usd', 'eur', 'gbp', 'jpy', 'cny', 'cad', 'aud', 'chf', 'nzd', 'sek', 'nok', 'dkk', 'pln', 'czk', 'huf', 'ron', 'bgn', 'hrk', 'rub', 'try', 'brl', 'mxn', 'sgd', 'hkd', 'krw', 'inr', 'thb', 'myr', 'php', 'idr', 'vnd', 'zar', 'ils', 'aed', 'sar', 'egp', 'kwd', 'qar', 'bhd', 'omr', 'jod', 'lbp', 'mad', 'dzd', 'tnd', 'ngn', 'ghs', 'kes', 'ugx', 'tzs', 'zmw', 'bwp', 'mur', 'scr', 'mvr', 'lkr', 'pkr', 'bdt', 'npr'];
        this.vsFiats = new Set(commonFiats);
        this.vsFiatsTs = now;
        console.log(`[RatePlugin] 使用本地法币列表，包含 ${this.vsFiats.size} 种货币`);
      }
    }
    return this.vsFiats.has(query.toLowerCase());
  }

  // (优化) 搜索货币 - 使用内置映射优先识别
  private async searchCurrency(query: string): Promise<{id: string, symbol: string, name: string, type: 'crypto' | 'fiat'} | null> {
    const qLower = query.toLowerCase();

    if (qLower === 'rm') {
      const result = { id: 'myr', symbol: 'MYR', name: 'Malaysian Ringgit', type: 'fiat' as const };
      this.currencyCache[qLower] = result;
      return result;
    }
    
    if (this.currencyCache[qLower]) {
      return this.currencyCache[qLower];
    }

    console.log(`[RatePlugin] 识别货币类型: ${query}`);
    
    // 先检查内置法币映射
    if (FIAT_CURRENCIES[qLower]) {
      const fiatInfo = FIAT_CURRENCIES[qLower];
      const result = { 
        id: qLower, 
        symbol: fiatInfo.symbol, 
        name: fiatInfo.name, 
        type: 'fiat' as const 
      };
      this.currencyCache[qLower] = result;
      console.log(`[RatePlugin] ${query} 从内置映射识别为法币`);
      return result;
    }
    
    // 再检查内置加密货币映射
    if (CRYPTO_CURRENCIES[qLower]) {
      const cryptoInfo = CRYPTO_CURRENCIES[qLower];
      const result = { 
        id: qLower, 
        symbol: cryptoInfo.symbol, 
        name: cryptoInfo.name, 
        type: 'crypto' as const 
      };
      this.currencyCache[qLower] = result;
      console.log(`[RatePlugin] ${query} 从内置映射识别为加密货币`);
      return result;
    }
    
    // 回退到动态检查
    if (await this.isFiat(qLower)) {
      console.log(`[RatePlugin] ${query} 动态识别为法币`);
      const result = { id: qLower, symbol: query.toUpperCase(), name: query.toUpperCase(), type: 'fiat' as const };
      this.currencyCache[qLower] = result;
      return result;
    }

    console.log(`[RatePlugin] ${query} 默认识别为加密货币`);
    const result = { id: qLower, symbol: query.toUpperCase(), name: query.toUpperCase(), type: 'crypto' as const };
    this.currencyCache[qLower] = result;
    return result;
  }

  private formatPrice(value: number): string {
    if (value >= 1) {
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (value >= 0.01) {
      return value.toFixed(4);
    } else if (value >= 0.0001) {
      return value.toFixed(6);
    } else {
      return value.toExponential(2);
    }
  }

  private formatAmount(value: number): string {
    if (value >= 1) {
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else {
      return value.toFixed(6);
    }
  }

  private buildFiatToFiatResponse(amount: number, convertedAmount: number, rate: number, sourceSymbol: string, targetSymbol: string): string {
    return `💱 <b>汇率</b>\n\n` +
      `${codeTag(`${this.formatAmount(amount)} ${sourceSymbol} ≈`)}\n` +
      `${codeTag(`${this.formatAmount(convertedAmount)} ${targetSymbol}`)}\n\n` +
      `📊 <b>汇率:</b> ${codeTag(`1 ${sourceSymbol} = ${this.formatAmount(rate)} ${targetSymbol}`)}\n` +
      `⏰ <b>更新时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  private buildCryptoToCryptoResponse(amount: number, convertedAmount: number, conversionRate: number, price: number, targetPrice: number, sourceSymbol: string, targetSymbol: string, lastUpdated: Date): string {
    return `💱 <b>汇率</b>\n\n` +
      `${codeTag(`${this.formatAmount(amount)} ${sourceSymbol} ≈`)}\n` +
      `${codeTag(`${this.formatAmount(convertedAmount)} ${targetSymbol}`)}\n\n` +
      `💎 <b>兑换比率:</b> ${codeTag(`1 ${sourceSymbol} = ${this.formatAmount(conversionRate)} ${targetSymbol}`)}\n` +
      `📊 <b>基准价格:</b> ${codeTag(`${sourceSymbol} $${this.formatPrice(price)} • ${targetSymbol} $${this.formatPrice(targetPrice)}`)}\n` +
      `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  private buildFiatToCryptoResponse(amount: number, cryptoAmount: number, price: number, cryptoSymbol: string, fiatSymbol: string, lastUpdated: Date): string {
    return `💱 <b>汇率</b>\n\n` +
      `${codeTag(`${this.formatAmount(amount)} ${fiatSymbol} ≈`)}\n` +
      `${codeTag(`${this.formatAmount(cryptoAmount)} ${cryptoSymbol}`)}\n\n` +
      `💎 <b>当前汇率:</b> ${codeTag(`1 ${cryptoSymbol} = ${this.formatPrice(price)} ${fiatSymbol}`)}\n` +
      `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  private buildCryptoToFiatResponse(amount: number, totalValue: number, price: number, cryptoSymbol: string, fiatSymbol: string, lastUpdated: Date): string {
    return `💱 <b>汇率</b>\n\n` +
      `${codeTag(`${this.formatAmount(amount)} ${cryptoSymbol} ≈`)}\n` +
      `${codeTag(`${this.formatAmount(totalValue)} ${fiatSymbol}`)}\n\n` +
      `💎 <b>当前汇率:</b> ${codeTag(`1 ${cryptoSymbol} = ${this.formatPrice(price)} ${fiatSymbol}`)}\n` +
      `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  private buildPriceResponse(price: number, cryptoSymbol: string, fiatSymbol: string, lastUpdated: Date): string {
    return `💱 <b>汇率</b>\n\n` +
      `${codeTag(`1 ${cryptoSymbol} = ${this.formatPrice(price)} ${fiatSymbol}`)}\n\n` +
      `⏰ <b>数据更新:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }

  private async handleRate(msg: Api.Message): Promise<void> {
    const text = msg.text?.trim() || "";
    const parts = text.split(/\s+/) || [];
    const [, ...args] = parts; // 跳过命令本身

    try {
      console.log(`[RatePlugin] 收到命令: ${text}`);
      if (!args[0]) {
        await msg.edit({
          text: help_text,
          parseMode: "html",
        });
        return;
      }

      if (args[0] === 'help' || args[0] === 'h') {
        await msg.edit({
          text: help_text,
          parseMode: "html",
        });
        return;
      }

      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      await msg.edit({ text: "⚡ 正在获取最新汇率数据...", parseMode: "html" });
      
      // 解析参数 - 智能识别货币类型
      const parsed = this.parseArgs(args as string[]);
      const input1 = parsed.base;
      const input2 = parsed.quote;
      const amount = parsed.amount;
      const googleQueryFallback = encodeURIComponent(`${amount} ${String(input1 || '').toUpperCase()} to ${String(input2 || '').toUpperCase()}`);
      const googleUrlFallback = `https://www.google.com/search?q=${googleQueryFallback}`;

      // 智能识别货币类型
      await msg.edit({
        text: "🔍 正在识别货币类型...",
        parseMode: "html"
      });
      
      const currency1 = await this.searchCurrency(input1!);
      if (!currency1) {
        await msg.edit({
          text: `❌ <b>货币未找到:</b> "${htmlEscape(input1!)}"\n\n💡 请检查拼写或使用标准代码\n\n🔎 <b>谷歌兜底:</b> <a href="${googleUrlFallback}">点击查看</a>`,
          parseMode: "html"
        });
        return;
      }
      
      let currency2: {id: string, symbol: string, name: string, type: 'crypto' | 'fiat'};
      if (input2) {
        const searchResult = await this.searchCurrency(input2);
        if (!searchResult) {
          await msg.edit({
            text: `❌ <b>货币未找到:</b> "${htmlEscape(input2)}"\n\n💡 请检查拼写或使用标准代码\n\n🔎 <b>谷歌兜底:</b> <a href="${googleUrlFallback}">点击查看</a>`,
            parseMode: "html"
          });
          return;
        }
        currency2 = searchResult;
      } else {
        // 默认使用USD
        currency2 = { id: 'usd', symbol: 'USD', name: 'USD', type: 'fiat' };
      }

      // 显示加载状态
      await msg.edit({
        text: "⏳ 正在获取汇率数据...",
        parseMode: "html"
      });

      // 使用全智能价格获取
      let price: number = 0;
      let lastUpdated: Date = new Date();
      
      console.log(`[RatePlugin] 智能查询: ${currency1.symbol} (${currency1.type}) -> ${currency2.symbol} (${currency2.type}), 数量: ${amount}`);
      
      // 验证货币类型识别
      if (currency1.type === 'fiat' && currency2.type === 'crypto') {
        console.log(`[RatePlugin] 检测到法币到加密货币转换: ${currency1.symbol} -> ${currency2.symbol}`);
      }
      
      try {
        const market = await this.getUniversalPrice(currency1.symbol, currency2.symbol, currency1.type, currency2.type);
        price = market.price;
        lastUpdated = market.lastUpdated;
      } catch (error: any) {
        console.error(`[RatePlugin] 价格获取详细错误:`, error);
        await msg.edit({
          text: `❌ <b>获取价格失败:</b> ${htmlEscape(error.message)}\n\n🔍 <b>调试信息:</b>\n• ${htmlEscape(currency1.symbol)} (${htmlEscape(currency1.type)})\n• ${htmlEscape(currency2.symbol)} (${htmlEscape(currency2.type)})`,
          parseMode: "html"
        });
        return;
      }

      // 智能构建响应消息
      const symbol1 = currency1.symbol.toUpperCase();
      const symbol2 = currency2.symbol.toUpperCase();
      const convertedAmount = amount * price;
      
      let responseText: string;
      
      // 根据货币类型组合选择合适的响应格式
      if (currency1.type === 'fiat' && currency2.type === 'fiat') {
        // 法币 -> 法币
        responseText = this.buildFiatToFiatResponse(amount, convertedAmount, price, symbol1, symbol2);
      } else if (currency1.type === 'crypto' && currency2.type === 'crypto') {
        // 加密货币 -> 加密货币
        let price1USD = 0, price2USD = 0;
        try {
          price1USD = (await this.getUniversalPrice(symbol1, 'USD', 'crypto', 'fiat')).price;
          price2USD = (await this.getUniversalPrice(symbol2, 'USD', 'crypto', 'fiat')).price;
        } catch {}
        responseText = this.buildCryptoToCryptoResponse(amount, convertedAmount, price, price1USD, price2USD, symbol1, symbol2, lastUpdated);
      } else if (currency1.type === 'fiat' && currency2.type === 'crypto') {
        // 法币 -> 加密货币
        responseText = this.buildFiatToCryptoResponse(amount, convertedAmount, 1/price, symbol2, symbol1, lastUpdated);
      } else if (currency1.type === 'crypto' && currency2.type === 'fiat') {
        // 加密货币 -> 法币
        if (amount !== 1) {
          responseText = this.buildCryptoToFiatResponse(amount, convertedAmount, price, symbol1, symbol2, lastUpdated);
        } else {
          responseText = this.buildPriceResponse(price, symbol1, symbol2, lastUpdated);
        }
      } else {
        responseText = `💱 <b>汇率</b>\n\n<code>${this.formatAmount(amount)} ${symbol1} ≈ ${this.formatAmount(convertedAmount)} ${symbol2}</code>\n\n📊 <b>汇率:</b> <code>1 ${symbol1} = ${this.formatPrice(price)} ${symbol2}</code>\n⏰ <b>更新时间:</b> ${lastUpdated.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      }

      await msg.edit({
        text: responseText,
        parseMode: "html"
      });  
    } catch (error: any) {
      console.error('[RatePlugin] 操作失败:', error);
      
      let errorMessage = '未知错误';
      let errorCode = '';
      
      if (axios.isAxiosError(error)) {
        errorCode = error.code || '';
        errorMessage = error.message;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      
      // 提供更友好的错误提示
      let userMessage = `❌ <b>操作失败</b>\n\n`;
      const rawText = msg.text?.trim() || '';
      const rawParts = rawText.split(/\s+/) || [];
      const [, ...rawArgs] = rawParts;
      const rawParsed = this.parseArgs(rawArgs as string[]);
      const fallbackQuery = encodeURIComponent(`${rawParsed.amount} ${String(rawParsed.base || '').toUpperCase()} to ${String(rawParsed.quote || '').toUpperCase()}`);
      const fallbackUrl = `https://www.google.com/search?q=${fallbackQuery}`;
      
      // 检查网络不可达错误
      if (errorCode === 'ENOTFOUND' || errorCode === 'ECONNREFUSED' || errorCode === 'ENETUNREACH') {
        userMessage += `🌐 <b>服务不可达</b>\n\n`;
        userMessage += `无法连接到汇率服务器，可能原因:\n`;
        userMessage += `• DNS 解析失败\n`;
        userMessage += `• 网络连接中断\n`;
        userMessage += `• 防火墙阻止访问\n`;
        userMessage += `• 需要配置代理\n\n`;
        userMessage += `💡 请检查网络设置后重试\n\n🔎 <b>谷歌兜底:</b> <a href="${fallbackUrl}">点击查看</a>`;
      } else if (errorCode === 'ECONNABORTED' || errorMessage.includes('超时') || errorMessage.includes('timeout')) {
        userMessage += `⏱ <b>请求超时</b>\n\n`;
        userMessage += `网络延迟过高或服务器响应缓慢\n\n`;
        userMessage += `💡 请稍后重试\n\n🔎 <b>谷歌兜底:</b> <a href="${fallbackUrl}">点击查看</a>`;
      } else if (errorMessage.includes('限流') || errorMessage.includes('429')) {
        userMessage += `⏱ <b>API请求过于频繁</b>\n\n`;
        userMessage += `请等待几分钟后再试\n\n🔎 <b>谷歌兜底:</b> <a href="${fallbackUrl}">点击查看</a>`;
      } else if (errorMessage.includes('网络')) {
        userMessage += `🌐 <b>网络连接问题</b>\n\n`;
        userMessage += `请检查网络连接是否正常\n\n🔎 <b>谷歌兜底:</b> <a href="${fallbackUrl}">点击查看</a>`;
      } else {
        userMessage += `错误详情: ${errorMessage}\n\n`;
        userMessage += `💡 如果问题持续，请联系管理员\n\n🔎 <b>谷歌兜底:</b> <a href="${fallbackUrl}">点击查看</a>`;
      }
      
      await msg.edit({ 
        text: userMessage,
        parseMode: "html"
      });
    }
  }
}

export default new RatePlugin();
