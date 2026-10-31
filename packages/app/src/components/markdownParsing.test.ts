import { describe, expect, it } from 'vitest'
import { extractFootnoteDefinitions, maskCjkEmphasisClose } from './markdownHtmlRenderer'
import { isDollarMathBoundary, scanTextSegments } from './markdownSegments'

describe('isDollarMathBoundary', () => {
  it('rejects amounts whose closing dollar is preceded by whitespace', () => {
    // 价格是 $5 到 $10 之间
    expect(isDollarMathBoundary('$5 到 $10 之间', 0, 5)).toBe(false)
  })

  it('accepts a tight formula', () => {
    expect(isDollarMathBoundary('$a+b$ 成立', 0, 4)).toBe(true)
  })

  it('rejects an opening dollar followed by whitespace', () => {
    expect(isDollarMathBoundary('$ a$ 文本', 0, 3)).toBe(false)
  })

  it('rejects a closing dollar followed by a digit', () => {
    expect(isDollarMathBoundary('$1$2', 0, 2)).toBe(false)
  })
})

describe('scanTextSegments currency handling', () => {
  it('keeps currency ranges as plain text', () => {
    expect(scanTextSegments('价格 $5 到 $10')).toEqual([{ type: 'text', text: '价格 $5 到 $10' }])
    expect(scanTextSegments('花费 $100 和 $200')).toEqual([{ type: 'text', text: '花费 $100 和 $200' }])
  })

  it('still scans real inline math', () => {
    expect(scanTextSegments('公式 $a+b$ 成立')).toEqual([
      { type: 'text', text: '公式 ' },
      { type: 'math', latex: 'a+b', display: false },
      { type: 'text', text: ' 成立' },
    ])
  })

  it('keeps a lone dollar literal', () => {
    expect(scanTextSegments('成本 $5 左右')).toEqual([{ type: 'text', text: '成本 $5 左右' }])
  })
})

describe('maskCjkEmphasisClose', () => {
  it('relaxes the close when punctuation is followed by a CJK character', () => {
    expect(maskCjkEmphasisClose('**重点：**正文')).toBe('**重点：** 文')
    expect(maskCjkEmphasisClose('*重点：*正文')).toBe('*重点：* 文')
    expect(maskCjkEmphasisClose('**（粗体）**后面')).toBe('**（粗体）** 面')
  })

  it('leaves a delimiter run that opens after punctuation untouched', () => {
    expect(maskCjkEmphasisClose('说明：**重点**内容')).toBe('说明：**重点**内容')
  })

  it('leaves already-valid emphasis and intraword underscores untouched', () => {
    expect(maskCjkEmphasisClose('**粗体**，继续')).toBe('**粗体**，继续')
    expect(maskCjkEmphasisClose('snake_case_word')).toBe('snake_case_word')
    expect(maskCjkEmphasisClose('a *b* c')).toBe('a *b* c')
  })
})

describe('extractFootnoteDefinitions', () => {
  it('pulls every definition out of the body', () => {
    expect(extractFootnoteDefinitions('[^a]: 甲\n[^b]: 乙')).toEqual({
      body: '',
      definitions: [
        { label: 'a', content: '甲' },
        { label: 'b', content: '乙' },
      ],
    })
  })

  it('keeps indented continuation lines in the definition', () => {
    expect(extractFootnoteDefinitions('[^a]: 一行\n    续行')).toEqual({
      body: '',
      definitions: [{ label: 'a', content: '一行\n续行' }],
    })
  })

  it('separates the definition from surrounding prose', () => {
    expect(extractFootnoteDefinitions('正文[^a]\n\n[^a]: 甲')).toEqual({
      body: '正文[^a]',
      definitions: [{ label: 'a', content: '甲' }],
    })
  })

  it('ignores definition-shaped lines inside code fences', () => {
    const source = '```md\n[^a]: 甲\n```'
    expect(extractFootnoteDefinitions(source)).toEqual({ body: source, definitions: [] })
  })
})
