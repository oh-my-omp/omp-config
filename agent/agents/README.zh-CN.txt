SUBAGENT 陷阱
=============

这里的 *.md 是自定义 agent 定义。下面每一条都是在本机实际观察到的，不是从文档推断的。
harness 参考：omp://task-agent-discovery.md、omp://tools/task.md、omp://tools/wait.md

本文件刻意用 .txt，见第 13 条。
英文版：README.txt（条目相同，与本文件同步修改）。


1. 没有 `spawns` 键时，子会话拿到一个永远派不出任何东西的 `task` 工具
-------------------------------------------------------------------
frontmatter 里既没有 `tools` 也没有 `spawns` 时，子会话得到一个空的派发策略，而 `task`
仍留在它的工具列表里。之后每次调用都在 preflight 被拒：

    Cannot spawn 'mentor:default'. Allowed: none (spawns disabled for this agent)

只有当 `tools` 列表本身包含 `task` 时，缺失的 `spawns` 才默认为 "*"（向后兼容行为，
omp://task-agent-discovery.md 的 "Agent definition shape"）。两个都不写，就得到一个死工具。
prompt 的措辞无法绕过这一点。


2. 优先用显式 allowlist，而不是 `spawns: "*"`
---------------------------------------------
两种写法的区别在于省略 `agent` 字段时解析到哪里：

    spawns: "*"        -> 省略的 `agent` 解析为内置的 `task`
    spawns: a, b, c    -> 省略的 `agent` 解析为列出的第一个名字

内置的 `task` 在 config.yml 的 `task.disabledAgents` 里（连同 `scout`、`sonic`、`reviewer`、
`security-reviewer`），所以 "*" 加上省略字段就是硬性的 preflight 失败。显式列表顺手堵上
这个坑——但要慎重选第一项，因为它是不声不响的默认值。`task-high.md` 是唯一会派其他 worker
的 worker，第一项是 `task:mid`（默认 worker 档次）；`task-free.md`、`task-low.md`、
`task-mid.md` 只列 `mentor:default`。


3. `task.disabledAgents` 里的名字即使列进 allowlist 也会失败
-------------------------------------------------------------
目前禁用：task、scout、sonic、reviewer、security-reviewer。把其中一个写进 `spawns` 不会让它
复活。普通 `task` 必须显式写 `agent`，否则会掉进第 2 条。`fork_task` 不同：所有子代理
都以内部 `fork:self` 运行，`agent` 只选模型绑定与角色。


4. 递归深度 2：孙代是叶子
------------------------
`task.maxRecursionDepth` 默认为 2。主 agent 派出的 worker 在深度 1；这个 worker 自己的子代
在深度 2，也就是上限——它的 `task` 工具被*移除*，派发策略被清空。

后果：深度 1 的 agent 可以再展开一层，但它分出去的东西必须能直接执行，绝不能是“再继续拆分”。
需要三层活跃层级的计划，必须从更浅一层开始。深度 2 派出的 worker 也够不到自己的
`mentor:default`。

观察到：深度 2 的 `task:free` 子代工具列表里没有 `task` 工具。


5. 唯一工具是 `yield` 的 agent 会悄无声息地丢掉答案
--------------------------------------------------
`mentor-default.md` 声明 `tools: []`，所以 `yield` 是它唯一的工具。观察到的失败链：

    把完整答案写成纯文本，没有工具调用
      -> harness 注入 "Last turn had no tool call -> session idle"
      -> 被迫补发的 `yield` 什么都没带
      -> job 以 `failed (exit 1)` 结束，并报 "Subagent called yield with null data."

这是真实的数据丢失，不是表面问题：`agent://<id>` 里根本没有答案。父会话只是碰巧从文本里
捞回来。修法是在 prompt 里写明：开场答案必须放进 `yield` 的载荷，一轮绝不能只以文字结束
（见 mentor-default.md 的 Dialogue 一节）。

任何被削减到只剩 `yield` 的 agent 都有这个风险，不只是 mentor。


6. `agent://` 和 `history://` 不是一回事
----------------------------------------
    agent://<id>            消费通道；`yield` 的载荷落在这里
    history://<id>          完整 transcript，显示它实际是怎么进行的
    agent://<id>?q=.field   从结构化结果里取出一个字段

失败的 job 可能在空 artifact 后面留下完好的 transcript（第 5 条）。调试失败的子代时先读
`history://`；只看 job 状态会被误导。


7. job id 会过期，agent id 不会
-------------------------------
job 行只在本进程内存在，结算后大约五分钟消失。之后 agent id 是唯一的把手：
`write agent://<id>`、`agent://<id>`、`history://<id>`。


8. 子代 yield 之后仍然可以联系
-----------------------------
yield 让子代进入 idle，之后进入 parked，但一条 `write agent://<id>` 消息会把它唤醒，上下文
完好；它用新的 `yield` 回答，作为一个新的 task 结果送到发送方。discussant 和 mentor 就是这样
进行多轮对话的。为继续同一话题而新派一个，会扔掉它读过的一切，还要重新付费。


9. plan mode 会悄悄改写子代
--------------------------
父会话处于 plan mode 时，子代被包装成只读：工具裁到 read/grep/glob/web_search，spawns 清空，
prewalk 清空。调试派发问题时，先确认自己不在 plan mode，否则测的是包装层而不是 agent 定义。


10. 改 agent 文件不用重启
-------------------------
每次派发前都会重新加载设置、重新发现 agent，所以这里的改动在下一次派发时生效。已经在跑的
子代保留它启动时的 prompt；活着的 agent 没有热重载。


11. 名字区分大小写，先到先得
----------------------------
项目 `.omp/agents` 覆盖用户 `~/.omp/agent/agents`，自定义覆盖内置；同一目录内按文件名的
字典序读取，重名的丢弃。`Task` 和 `task` 是两个不同的 agent。


12. 一个坏定义不会拖垮其他定义
------------------------------
自定义 agent 文件的 frontmatter 出错时，记一条 warning 并跳过该文件。只有内置定义的解析
错误是致命的。所以你改坏的文件表现为“那个 agent 莫名其妙不存在”，而不是解析错误——去
~/.omp/logs 找 warning，不要指望在调用处看到失败。


13. 不要在这个目录里留非 agent 的 .md
------------------------------------
这里的每个 .md 都会被当成 agent 定义候选解析。一份普通笔记会在每次发现时产生：

    warn "Failed to read agent file"
    AgentParsingError: Failed to parse agent: Invalid agent field: .../<file>.md

观察到每次派发出现两次。按第 12 条它无害，但会成为每次派发都有的永久日志噪声。笔记一律用
.txt——非 markdown 文件从不被扫描。
