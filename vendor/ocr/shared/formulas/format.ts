/**
 * 数值格式化工具。
 *
 * 综合值必须按"截断"处理（Arcaea 实测为截断而非四舍五入），
 * 直接用 `Math.floor(v * 10**d) / 10**d` 会引入浮点误差
 * （例如 12.6935 * 10000 = 126934.99999999999，截断后变成 12.6934）。
 *
 * 更隐蔽的坑：`(14.1).toFixed(20) === "14.09999999999999964473"`，
 * 若直接对这个字符串切片取 4 位小数会得到 "14.0999"（末位 -1）。
 * 因此这里先把 double 归一化成 15 位有效数字的十进制串，
 * 消除二进制表示噪声后再做截断（15 位足以覆盖本工具的所有数量级，
 * 因为 Arcaea 的 PTT 计算精度在 1e-11 量级）。
 */

/** 判断是否为科学计数法文本 */
function isExponential(text: string): boolean {
  return text.includes('e') || text.includes('E')
}

/**
 * 把 double 转成"干净"的十进制字符串。
 * 使用 15 位有效数字：足以表达真实值，又能抹掉 1e-16 量级的二进制噪声。
 */
export function toPlainString(value: number, sigDigits = 15): string {
  if (!Number.isFinite(value)) throw new Error(`无法格式化的数值：${value}`)
  const negative = value < 0
  const abs = Math.abs(value)
  let text = abs.toPrecision(sigDigits)
  if (isExponential(text)) {
    // 极端量级下回退到定点表示
    text = abs.toFixed(20)
  }
  if (text.includes('.')) {
    text = text.replace(/0+$/, '').replace(/\.$/, '')
  }
  if (text === '') text = '0'
  return `${negative ? '-' : ''}${text}`
}

/**
 * 按指定小数位截断（向零方向），返回十进制字符串。
 * truncateTo(12.693505, 4) === "12.6935"
 * truncateTo(14.1, 4) === "14.1000"
 */
export function truncateTo(value: number, decimals: number): string {
  if (decimals < 0) throw new Error(`小数位不能为负：${decimals}`)
  const text = toPlainString(value)
  const negative = text.startsWith('-')
  const unsigned = negative ? text.slice(1) : text
  const [int = '0', frac = ''] = unsigned.split('.')
  const kept = frac.slice(0, decimals).padEnd(decimals, '0')
  const sign = negative && /[1-9]/.test(int + kept) ? '-' : ''
  return decimals === 0 ? `${sign}${int}` : `${sign}${int}.${kept}`
}

/**
 * 按指定小数位四舍五入，返回十进制字符串。
 * （仅用于分数展示等场景，综合值一律用 truncateTo）
 */
export function roundTo(value: number, decimals: number): string {
  if (decimals < 0) throw new Error(`小数位不能为负：${decimals}`)
  const text = toPlainString(value)
  const negative = text.startsWith('-')
  const unsigned = negative ? text.slice(1) : text
  const [int = '0', frac = ''] = unsigned.split('.')
  const kept = frac.slice(0, decimals).padEnd(decimals, '0').split('')
  const nextDigit = frac.charAt(decimals)

  let carry = nextDigit !== '' && Number.parseInt(nextDigit, 10) >= 5
  const digits = [...int.split(''), ...kept]
  for (let i = digits.length - 1; i >= 0 && carry; i--) {
    const d = Number.parseInt(digits[i], 10) + 1
    if (d >= 10) {
      digits[i] = '0'
      carry = true
    } else {
      digits[i] = String(d)
      carry = false
    }
  }
  if (carry) digits.unshift('1')

  const intPart = digits.slice(0, digits.length - decimals).join('') || '0'
  const fracPart = decimals > 0 ? digits.slice(digits.length - decimals).join('') : ''
  const sign = negative && /[1-9]/.test(intPart + fracPart) ? '-' : ''
  return decimals === 0 ? `${sign}${intPart}` : `${sign}${intPart}.${fracPart}`
}

/** 按综合值规格格式化 */
export function formatComposite(
  value: number,
  decimals: number,
  rounding: 'truncate' | 'round'
): string {
  return rounding === 'truncate' ? truncateTo(value, decimals) : roundTo(value, decimals)
}

/** 限制在 [min, max] 区间 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
