// Hardcoded calibration for subagent_usage, generated once on 2026-11-01 from this machine's
// ~/.omp/agent/sessions (25,360 transcripts, 21,790 eligible subagent dispatches since 2026-08)
// and `omp usage --history --days 45`. Runtime code only reads these tables; it never rescans
// global history to regenerate them.
//
// Eligible dispatch: a subagent transcript whose `session_init` names its agent, that wrote
// `session_exit`, never recorded `resolvedModelIsFallback`, and whose assistant messages all ran
// on the model `session_init.resolvedModel` names. Its cost is the summed `usage.cost.total` of
// its assistant and `model_usage` entries on that model's provider.

/** When the tables below were generated. */
export const CALIBRATED_AT = "2026-11-01";

/**
 * Pooled within-group standard deviation of ln(USD per dispatch), over agent+model+thinking
 * groups with at least 10 priced dispatches. The observed estimator's lognormal spread.
 */
export const LOG_COST_SIGMA = 0.897;

/** Arithmetic mean USD per priced eligible dispatch across every agent and model. */
export const GLOBAL_DISPATCH_USD = 1.1644;

/** Mean USD per dispatch, keyed `agent|provider/model|thinking` (empty thinking: none in the binding); n >= 10. */
export const DISPATCH_USD_BY_AGENT: Readonly<Record<string, number>> = {
	"argon|google-antigravity/gemini-4-argon|": 1.8548,
	"behavior-analyst|openai-codex/gpt-5.6-luna|max": 0.1812,
	"bounded|commandcode/deepseek/deepseek-v4.1-flash|max": 0.0004,
	"bounded|commandcode/meta/muse-spark-1.3-contributor|xhigh": 0,
	"bounded|openai-codex/gpt-5.6-luna|max": 0.5207,
	"bounded|opencode-go/muse-spark-1.3-contributor|xhigh": 0.0394,
	"design:ctl|anthropic/claude-opus-5-5|": 102.2665,
	"design:fix|anthropic/claude-opus-5-5|": 7.0944,
	"discuss:astra|openai-codex/gpt-6-astra|": 12.18,
	"discuss:divergent|anthropic/claude-opus-5-5|medium": 1.3752,
	"discuss:divergent|commandcode/deepseek/deepseek-v4.1-flash|": 0.1804,
	"discuss:steady|openai-codex/gpt-5.6-luna|max": 0.1785,
	"discuss:steady|openai-codex/gpt-5.6-sol|medium": 1.4558,
	"discuss:steady|openai-codex/gpt-6-astra|medium": 1.4926,
	"discuss:steady|openai-codex/gpt-6-luna|max": 0.0587,
	"fork:self|anthropic/claude-opus-5-5|high": 1.9067,
	"mentor:default|openai-codex/gpt-5.6-luna|": 0.0102,
	"mentor:default|openai-codex/gpt-5.6-sol|": 0.1426,
	"mentor:default|openai-codex/gpt-5.6-sol|high": 0.1118,
	"mentor:default|opencode-go/deepseek-v4.1-flash|": 0.0077,
	"mentor:default|opencode-go/muse-spark-1.3-contributor|": 0.002,
	"scout|openai-codex/gpt-6-astra|medium": 0,
	"secretary|openai-codex/gpt-6.1-sol|high": 0.5637,
	"specified|commandcode/meta/muse-spark-1.3-contributor|": 0,
	"specified|commandcode/meta/muse-spark-1.3-contributor|xhigh": 0,
	"ssot-clone-01a164ea|anthropic/claude-opus-5-5|": 4.828,
	"ssot-clone-01a164ea|anthropic/claude-opus-5-5|high": 4.8612,
	"ssot:argon|google-antigravity/gemini-4-argon|high": 4.1006,
	"ssot:fable|anthropic/claude-fable-5-1|high": 7.9275,
	"task:bounded|openai-codex/gpt-5.6-luna|max": 0.2264,
	"task:free|bansos/muse-spark-1.3-contributor-free|xhigh": 0,
	"task:free|opencode-go/muse-spark-1.3-contributor|xhigh": 0.0075,
	"task:high|anthropic/claude-opus-4-8|high": 13.6399,
	"task:high|anthropic/claude-opus-5-5|high": 6.6316,
	"task:high|anthropic/claude-opus-5-5|medium": 5.3544,
	"task:high|openai-codex/gpt-6-astra|": 15.5869,
	"task:low|bansos/muse-spark-1.3-contributor-free|xhigh": 0,
	"task:low|openai-codex/gpt-5.6-luna|max": 0.173,
	"task:low|openai-codex/gpt-6-luna|max": 0.0603,
	"task:low|opencode-go/muse-spark-1.3-contributor|xhigh": 0.058,
	"task:mid|openai-codex/gpt-5.6-luna|max": 0.3865,
	"task:mid|openai-codex/gpt-6-luna|max": 0.0796,
	"task:mid|openai-codex/gpt-6-sol|high": 0.9074,
	"task:mid|openai-codex/gpt-6.1-sol|high": 0.8367,
	"task:mid|opencode-go/deepseek-v4.1-flash|": 0.1595,
	"task|openai-codex/gpt-6-astra|medium": 0,
	"unrestricted|openai-codex/gpt-6-astra|": 4.6015,
};

/** Mean USD per dispatch across agents, keyed `provider/model|thinking`; n >= 10. */
export const DISPATCH_USD_BY_MODEL: Readonly<Record<string, number>> = {
	"anthropic/claude-fable-5-1|high": 7.9275,
	"anthropic/claude-opus-4-8|high": 13.6399,
	"anthropic/claude-opus-5-5|": 21.3369,
	"anthropic/claude-opus-5-5|high": 5.5737,
	"anthropic/claude-opus-5-5|medium": 3.2143,
	"bansos/muse-spark-1.3-contributor-free|xhigh": 0,
	"commandcode/deepseek/deepseek-v4.1-flash|": 0.1804,
	"commandcode/deepseek/deepseek-v4.1-flash|max": 0.0004,
	"commandcode/meta/muse-spark-1.3-contributor|": 0,
	"commandcode/meta/muse-spark-1.3-contributor|xhigh": 0,
	"google-antigravity/gemini-4-argon|": 1.8548,
	"google-antigravity/gemini-4-argon|high": 4.1006,
	"openai-codex/gpt-5.6-luna|": 0.0114,
	"openai-codex/gpt-5.6-luna|max": 0.3234,
	"openai-codex/gpt-5.6-sol|": 0.1426,
	"openai-codex/gpt-5.6-sol|high": 0.1122,
	"openai-codex/gpt-5.6-sol|medium": 1.4558,
	"openai-codex/gpt-6-astra|": 6.8135,
	"openai-codex/gpt-6-astra|high": 0,
	"openai-codex/gpt-6-astra|medium": 1.2366,
	"openai-codex/gpt-6-luna|max": 0.0606,
	"openai-codex/gpt-6-sol|high": 0.9074,
	"openai-codex/gpt-6.1-sol|high": 0.831,
	"opencode-go/deepseek-v4.1-flash|": 0.0702,
	"opencode-go/muse-spark-1.3-contributor|": 0.002,
	"opencode-go/muse-spark-1.3-contributor|xhigh": 0.052,
};

/**
 * USD of local spend per 100% of one account's quota limit, keyed `provider|limitId|windowId`.
 * Ratio of this machine's spend on the models the provider strategy scopes to the limit over the
 * summed per-account usedFraction increase, counting only hours where every account carrying the
 * limit had a same-reset snapshot pair and every other account of the provider was idle; the
 * smaller of that ratio and the 25th percentile of weekly ratios (3+ weeks). Other machines
 * sharing an account lower the ratio (fewer dispatches predicted); rolling-window decay hidden
 * between hourly snapshots raises it, which the weekly 25th percentile offsets.
 */
export const USD_PER_LIMIT: Readonly<Record<string, number>> = {
	"anthropic|anthropic:5h|5h": 872.3,
	"anthropic|anthropic:7d|7d": 2770.7,
	"anthropic|anthropic:7d:fable|7d": 392.6,
	"commandcode|commandcode:7d|7d": 18.2,
	"google-antigravity|google-antigravity:anthropic:default:3p-5h|5h": 11.4,
	"google-antigravity|google-antigravity:anthropic:default:3p-weekly|weekly": 22.5,
	"google-antigravity|google-antigravity:google:default:gemini-5h|5h": 51.9,
	"google-antigravity|google-antigravity:google:default:gemini-weekly|weekly": 181.6,
	"openai-codex|openai-codex:primary|5h": 54.5,
	"openai-codex|openai-codex:primary|7d": 1313.5,
	"openai-codex|openai-codex:secondary|7d": 276.7,
	"opencode-go|rolling-5h|5h": 1.7,
	"opencode-go|weekly|7d": 4.1,
};
