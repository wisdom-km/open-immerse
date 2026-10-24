# DPO 多模态 A/B 报告

schema: `open-immerse.mm-dpo-ab/v1` · mode: `template`

论文 arXiv 2305.18290v3，页 3、4、5。参考公式数 79（不是合入门槛）。

整页臂默认关闭，必须 `--arm=page`。脚本不发送整页 PDF。本报告不进扩展包，也不改设置预置。

## 字段

| 计划 §5 | JSON |
| --- | --- |
| LaTeX | `latex` |
| 核对 | `verify` |
| 上屏方式 | `paint` |
| 渲染等价? | `matchesReference` |
| 耗时 | `latencyMs` |
| token | `tokens` |
| 核对过但与参考不一致 | `checkedButMismatch`（汇总 0） |

核对过但与参考不一致：0

## 输入臂

- `tight`（默认）：现有紧裁 PNG，走 cropPngFor。默认臂。
- `hi-res`：高清裁图。产品路径未落地时不发送，除非另接 visionCropFor。
- `paragraph`：段落图加段落文字。产品路径未落地时不发送。
- `page`，需要 `--arm=page`：整页对照，只在脚本里。默认关。不发送整页 PDF，也不能成为产品默认。

## 通道

- primary `kimi` / `kimi-k3` · MM_DPO_KIMI_API_KEY · hasKey=false
- baseline `deepseek` / `deepseek-v4.1-flash` · MM_DPO_DEEPSEEK_API_KEY · hasKey=false

## 分臂汇总

| arm | provider | model | sent | verified | 渲染等价 | 核对过但与参考不一致 | 耗时合计 | token 合计 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tight | kimi | kimi-k3 | 0 | 0 | 0/0 | 0 | 0 | 0 |
| tight | deepseek | deepseek-v4.1-flash | 0 | 0 | 0/0 | 0 | 0 | 0 |

## 推荐

arm=— provider=— model=— reason=no-measured-rows

本脚手架不改设置预置，也不因分数挡合入。整页臂不能成为产品默认。

writesPreset=false productDefault=false provisional=true

## 示例

示例不计入汇总。

### example · tight · kimi/kimi-k3

- LaTeX: `x`
- 核对: checked=true pass=true reason=— jaccard=1
- 上屏方式: katex（核对通过，上屏 KaTeX）
- 渲染等价: false
- 耗时: 0 ms
- token: 0/0/0
- 核对过但与参考不一致: true

## 逐条

（无）

