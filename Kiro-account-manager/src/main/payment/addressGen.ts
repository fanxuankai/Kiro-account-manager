// 中国账单地址生成器 —— 数据来自公开数据集转换的 cn-address.json
// （省→市→区→邮编，2023 区划口径，见仓库 scripts 历史）。邮编与市/区
// 真实对应，满足「邮编一定要对」；省市名英文形态与 Stripe 中国地址表单
// 的拼音风格一致（Hangzhou Shi / Jianggan Qu）。

import addressData from './cn-address.json'

/** 生成的账单地址（英文形态，直接对应 Stripe 表单字段） */
export interface BillingAddress {
  /** 姓名，如 "HE XIN" */
  name: string
  /** 6 位邮编，与市/区真实对应 */
  zip: string
  /** 市，如 "Hangzhou Shi" */
  city: string
  /** 区/县，如 "Shangcheng Qu" */
  district: string
  /** 街道+门牌，如 "Yongjiang Lu 78" */
  street: string
  /** 省中文（生成时指定或随机） */
  provinceZh: string
  /** 省英文主体，如 "Zhejiang"（表单/下拉匹配用） */
  provinceEn: string
}

interface RawProvince {
  p: string
  pe: string
  cities: Array<{ c: string; ce: string; ds: Array<{ n: string; ne: string; z: string }> }>
}

const provinces = addressData as RawProvince[]

// ─── 随机素材库 ─────────────────────────────────────────────────────

/** 常见路名（拼音形态与真实街景一致，Stripe 不校验街道真实性） */
const STREETS = [
  'Renmin Lu', 'Jiefang Lu', 'Zhongshan Lu', 'Jianshe Lu', 'Heping Lu', 'Xinhua Lu',
  'Minzu Lu', 'Wenhua Lu', 'Youyi Lu', 'Xingfu Lu', 'Guangming Lu', 'Shengli Lu',
  'Qingnian Lu', 'Binjiang Lu', 'Yanan Lu', 'Yucai Lu', 'Tiyu Lu', 'Gongyuan Lu',
  'Haiyan Lu', 'Fenghuang Lu', 'Tianhe Lu', 'Datong Lu', 'Taiping Lu', 'Yongxing Lu',
  'Jinxiu Lu', 'Chunhui Lu', 'Kangning Lu', 'Fuxing Lu', 'Wangjiang Lu', 'Chaoyang Lu',
  'Nanhuan Lu', 'Beihuan Lu', 'Dongfeng Lu', 'Hongqi Lu', 'Jinhe Lu', 'Yuelu Lu',
  'Zhonghua Lu', 'Changjiang Lu', 'Huanghe Lu', 'Yongjiang Lu', 'Zijin Lu', 'Baihua Lu'
]

/** 拼音姓（常见百家姓） */
const SURNAMES = [
  'Wang', 'Li', 'Zhang', 'Liu', 'Chen', 'Yang', 'Huang', 'Zhao', 'Wu', 'Zhou',
  'Xu', 'Sun', 'Ma', 'Zhu', 'Hu', 'Guo', 'He', 'Lin', 'Luo', 'Zheng',
  'Liang', 'Xie', 'Song', 'Tang', 'Deng', 'Feng', 'Han', 'Cao', 'Zeng', 'Peng',
  'Xiao', 'Cai', 'Pan', 'Tian', 'Dong', 'Yuan', 'Yu', 'Ye', 'Du', 'Su',
  'Wei', 'Cheng', 'Lu', 'Ding', 'Ren', 'Shen', 'Yao', 'Jiang', 'Cui', 'Zhong',
  'Tan', 'Lu', 'Fan', 'Jin', 'Shi', 'Liao', 'Jia', 'Xia', 'Wei', 'Fu',
  'Fang', 'Bai', 'Zou', 'Meng', 'Xiong', 'Qin', 'Qiu', 'Yin', 'Xue', 'Yan'
]

/** 拼音名（单字+双字混合，与真实取名分布接近） */
const GIVEN_NAMES = [
  'Xin', 'Tao', 'Lei', 'Ming', 'Hua', 'Jun', 'Qiang', 'Wei', 'Fang', 'Min',
  'Jing', 'Bo', 'Yu', 'Hao', 'Peng', 'Kai', 'Long', 'Fan', 'Yan', 'Yun',
  'Xinyu', 'Jiaming', 'Zihan', 'Yuchen', 'Haoran', 'Siqi', 'Xinyi', 'Jiale',
  'Wenbo', 'Zhiqiang', 'Lijun', 'Mingze', 'Yuhui', 'Tianyu', 'Chenxi', 'Yuxuan',
  'Shanshan', 'Xiaoting', 'Liting', 'Wanting', 'Jiaqi', 'Mengqi', 'Yuting'
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ─── 对外接口 ───────────────────────────────────────────────────────

/** 省份中文列表（供 UI 下拉；按区划码顺序稳定输出） */
export function listProvinces(): string[] {
  return provinces.map((p) => p.p)
}

/** 校验省份中文名是否在数据集内 */
export function isValidProvince(provinceZh: string): boolean {
  return provinces.some((p) => p.p === provinceZh)
}

/**
 * 生成一条随机中国账单地址。
 * @param provinceZh 指定省份中文名（如 "浙江省"）；缺省随机。无效省份名回退随机。
 */
export function generateBillingAddress(provinceZh?: string): BillingAddress {
  const prov =
    provinces.find((p) => p.p === provinceZh) || pick(provinces)
  const city = pick(prov.cities)
  // 直筒子市（东莞/中山等）数据集以市自身为区县条目，此时区名直接沿用市名
  const district = pick(city.ds)
  const districtName =
    district.ne && district.ne !== city.ce ? district.ne : city.ce

  return {
    name: `${pick(SURNAMES)} ${pick(GIVEN_NAMES)}`.toUpperCase(),
    zip: district.z,
    city: city.ce,
    district: districtName,
    street: `${pick(STREETS)} ${Math.floor(1 + Math.random() * 398)}`,
    provinceZh: prov.p,
    provinceEn: prov.pe
  }
}
