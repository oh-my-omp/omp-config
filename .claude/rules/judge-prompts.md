---
paths:
  - agent/extensions/turn-judge/**
  - agent/extensions/tool-policy-nag/INTENT-*.md
  - agent/extensions/tool-policy-nag/intent.ts
  - agent/extensions/watchdog-agent/**
  - agent/extensions/lang-nag/**
  - agent/extensions/_shared/judge.ts
  - agent/extensions/tool-topics/TOPIC-*judge*.md
  - ~/.omp/agent/extensions/**/{TURN-JUDGE,INTENT,WATCHDOG}-*.md
---

# 编写 judge 问题

本仓库经 `openJudge` 发出的问题（`TURN-JUDGE-*.md`、`INTENT-*.md`、`WATCHDOG-*.md` 的选项模式、`lang-nag` 等）面向 TypeSafe System One 判定模型（Jev；本机经 `futureppo-jev` 中转）。Jev 不是聊天模型：它对每个问题独立给出校准过的概率，适合一眼能判断的单个判断，不适合推理、计数或多步间接。按聊天 prompt 的写法去写问题会失效：旧版 `gpt-talk-only` 用一个 Choice 判断“该不该收工”，19 个提前收工只命中 3 个；拆成可观察的 Noul 并由规则组合后，命中 11 个，误报仍为 0。

## 判断交给模型，决定留在规则里

- 先写出要做的决定和它依赖的输入，再给每个输入一个问题。“该不该发提示”“这一轮是否正当”是决定，不是问题。
- 每个问题只问一件能在 state 里指认的事：“`本轮回复` 是否宣布自己接下来要做什么”，而不是“是否只说不做”。问题里出现“或/且”、规则清单、多种情形的罗列，就拆成多个问题。
- 多个陈述可能同时成立时，每个陈述用一个 Noul。Choice 只用于真正互斥的类别；一条回复可以同时“汇报了工作”“认了错”“说还剩什么”，用 Choice 会把概率分散到几个选项上，任何选项都过不了阈值。
- Choice 总会选一个选项。需要“都不符合”时，在同一请求里另加一个 Noul 问“是否有任一选项适用”，比加 `none of the above` 选项可靠。
- 代码能精确算出的不要问模型：有没有工具调用、条目数量、日期先后、字符串匹配。

## 措辞

- instructions 用英文写。Jev 以英文为主，中文等 CJK 文本可以接受但准确率较低；state 里的中文内容和中文字段名照常传。
- 用反引号路径点名问题针对的 state 字段，例如 `本轮回复`、`时间线`；不要让模型自己去找。
- 写成肯定句，让“是”对应高概率；避免双重否定和“不是 X 的情况”这类反向表述。
- Jev 按字面理解。边界情形写进 criteria：Noul 的 `true`/`false` 各写一个具体情境（“The reply ends with a statement.”），不要写成“not X”。看到错答时，你想补充解释“我其实是想问……”的那句话，就是 instructions 缺的那一半。
- 选项名和 criteria 会发给模型，问题 id 不会。选项名要描述内容（`reports_blocker`），不用 `A`/`option_1`；选项之间不要共用措辞，共用的词会把概率吸到那些选项上。
- Choice 可能偏向第一个选项：调换选项顺序重跑一次，答案应当不变。
- 不写前言、“请考虑 X、Y、Z”、输出格式说明；问题不是聊天 prompt。

## State

- 只放判断需要的内容。无关内容是干扰项，会拉低所有问题的准确率；同一请求里所有问题共享同一个 state。
- 注意体积：本仓库将判定请求上限定为 64KB（代码常量 `MAX_BYTES_LIMIT`，`agent/extensions/turn-judge/state.ts`）。`时间线` 很长的回合会超时或失败，评测时这类回合要单独统计，不能算作“否”。
- 用带描述性键名的 JSON 对象，不要把序列化后的 JSON 字符串塞进去。

## 阈值与评测

- Noul 从 0.7（是）/ 0.3（否）起步，按误判代价调整；只用 0.3、0.5、0.6、0.7 这类粗档，不按单个样本微调。
- 阈值和规则必须在人工标注的真实回合上评测：正例、反例都要有，并与旧版本在同一批 state 上对比。命中数、误报数、未标注回合的触发数分开报告，并逐条读未标注回合的触发样本。
- 在 `eval` 里用 `judgeBatch` 跑评测，不在 bash 里另写脚本绕开 eval。同一批 state 的全部问题放在一次请求里；中转共享时并发不超过 4，批量评测期间不要同时做真实会话验证，否则真实会话的判定会超时。
- 警惕“prompt 体操”：为让某个失败样本通过而给 criteria 加从句、在 criteria 里点名测试样本、把阈值卡在个别样本上。正确的修法通常是更好的 state、单独的问题或规则。
- 判定失败（超时、无回答）按未判定处理，不能当成“否”。
- `@<扩展名>` 绑定聊天模型后由提示式判定作答，Noul 只会得到接近 0 或 1 的值，按 Jev 校准的阈值不再适用。

## 参考资料

- TypeSafe 文档索引（每页加 `.md` 取 Markdown）：https://docs.typesafe.ai/llms.txt
- 问题类型与写法：https://docs.typesafe.ai/primitives.md 、https://docs.typesafe.ai/primitives/noul.md 、https://docs.typesafe.ai/primitives/choice.md
- State 的组织：https://docs.typesafe.ai/concepts/state.md
- 已知弱点与对策（字面理解、计数、日期、间接、大 state、选项顺序）：https://docs.typesafe.ai/model-jaggedness.md
- 伴随 Noul、按概率分流等模式：https://docs.typesafe.ai/patterns.md
- TypeSafe 官方 agent skill（问题、state、阈值、评测的完整建议）：https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md
- System One 原语说明：https://docs.system-one.dev/en/docs/primitives
