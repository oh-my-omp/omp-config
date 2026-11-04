---
name: gpt-talk-only
target: main
model: (^|/)[Gg][Pp][Tt]
skipTools: wt, harness_restart
inject: user
question.says_remaining: Does `本轮回复` say that some of the assistant's work is still not done, not run, not committed, not pushed or not verified?
question.says_remaining.true: The reply names work that is still missing, such as tests not run, changes not committed, or steps left for later.
question.says_remaining.false: The reply presents the work as complete, or the reply is only an answer to a question.
question.announces_future: Does `本轮回复` say what the assistant will do next or is about to do?
question.announces_future.true: The reply contains a statement such as "Next I will…", "我会…", "接下来…" about the assistant's own upcoming action.
question.announces_future.false: The reply only describes what already happened, or offers options for the user to choose.
question.admits_mistake: Does `本轮回复` admit that the assistant made a mistake?
question.asks_user: Does `本轮回复` ask the user a question or ask the user to make a decision?
question.asks_user.true: The reply ends with a question or a choice addressed to the user.
question.asks_user.false: The reply ends with a statement.
question.user_forbids_work: Does a 用户说 entry in `时间线` tell the assistant not to edit, not to run anything, to stop, or to only answer?
question.external_blocker: Does `本轮回复` name an obstacle outside the assistant's control that stops the work, such as a failing external service, missing credentials, or a merge conflict that needs the user?
when.unfinished_after_mistake: says_remaining >= 0.6 & admits_mistake >= 0.5 & asks_user < 0.5 & user_forbids_work < 0.5 & external_blocker < 0.5
when.unfinished_with_plan: says_remaining >= 0.6 & announces_future >= 0.3 & asks_user < 0.5 & user_forbids_work < 0.5 & external_blocker < 0.5
prompt: 你停下了，但交代的工作还没做完。不要只宣布下一步或认错：现在就用工具继续做，直到有可验证的结果。确实被阻塞时，先做完所有能做的部分，再说明试过什么、缺的具体前置条件是什么。
---
