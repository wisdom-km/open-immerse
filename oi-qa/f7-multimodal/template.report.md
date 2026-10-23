# DPO 多模态 A/B 报告

schema: `open-immerse.mm-dpo-ab/v1` · mode: `template`

论文 arXiv 2305.18290v3，页 3、4、5。参考公式数 79（不是合入门槛）。

整页臂默认关闭，必须 `--arm=page`。脚本不发送整页 PDF。本报告不进扩展包，也不改设置预置。

高清裁图：tier `mm-3`，scale 4，路径 visionCropFor。段落臂是脚本实验。

## 字段

| 计划 §5 | JSON |
| --- | --- |
| LaTeX | `latex` |
| 核对 | `verify` |
| 上屏方式 | `paint` |
| 与参考一致? | `matchesReference` |
| 耗时 | `latencyMs` |
| token | `tokens` |
| 核对过但与参考不一致 | `checkedButMismatch`（汇总 0） |

核对过但与参考不一致：0

## 输入臂

- `tight`（默认）：现有紧裁 PNG，走 cropPngFor。默认臂。
- `hi-res`：产品高清裁图（visionCropFor / renderVisionCrop，mm-3，scale 4）。没有页面渲染时不发送。
- `paragraph`：脚本实验：段落区域按同一高清倍率出图，并附上段落文字。不改产品默认，也不改产品提示词。
- `page`，需要 `--arm=page`：整页对照，只在脚本里。默认关。不发送整页 PDF，也不能成为产品默认。

## 通道

- primary `kimi` / `kimi-k3` · MM_DPO_KIMI_API_KEY · hasKey=false
- baseline `deepseek` / `deepseek-v4.1-flash` · MM_DPO_DEEPSEEK_API_KEY · hasKey=false

## 样本

stratified=false locked=false requested=— count=0
（无）

## 估价

- `kimi` / `kimi-k3`：输入 $3/百万，输出 $15/百万。Moonshot 公开标价（缓存未命中的输入 / 输出）。不是账单。

失败（已发送但没有 LaTeX）：0

## 分臂汇总

| arm | provider | model | sent | verified | 逐字一致 | 与参考一致 | 核对过但与参考不一致 | 失败 | 耗时合计 | token 合计 | 估算美元 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tight | kimi | kimi-k3 | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | — |
| tight | deepseek | deepseek-v4.1-flash | 0 | 0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 | — |

## 推荐

arm=— provider=— model=— reason=no-measured-rows

本脚手架不改设置预置，也不因分数挡合入。整页臂不能成为产品默认。

writesPreset=false productDefault=false provisional=true

## D2

paragraph 只有在 Kimi K3 上归一化准确率明显高于 hi-res 时才作为建议默认；否则建议 hi-res。本报告不改产品默认。

suggestedArm=— clearlyBetter=null hi-res=— paragraph=—

writesPreset=false productDefault=false

## 示例

示例不计入汇总。

### example · tight · kimi/kimi-k3

- LaTeX: `x`
- 核对: checked=true pass=true reason=— jaccard=1
- 上屏方式: katex（核对通过，上屏 KaTeX）
- 与参考一致（逐字）: false
- 与参考一致: false
- 耗时: 0 ms
- token: 0/0/0
- 核对过但与参考不一致: true

## 逐条

（无）

