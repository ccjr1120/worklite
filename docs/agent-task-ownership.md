# Agent task ownership and recovery

The lead owns the user's goal, deliverables and final report. Specialists are optional
execution templates. A specialist failure is returned to the lead as evidence to act on;
it does not automatically fail the task or trigger a fixed retry pipeline.

## Chat routing boundary

Chat passes the original user request, explicit constraints and necessary existing context
to the selected top-level Agent. Research, fact checking, planning and domain decisions
belong to that Agent. Chat must not research the subject before dispatch or add its own
outline, conclusions, length, image count or deliverables. Context is evidence, not a new
requirement; uncertain premises remain for the Agent to verify. This applies to new and
continued tasks. The rule is included in seeded Chat/Skill instructions and injected on
every Chat model turn so older execution snapshots also receive it after the API updates.

For example, “claude官方抛弃git去自研了一个类似的代码管理，帮我写一篇文章介绍下”
is already a complete delegation request. Forward it without a Chat-authored research
brief; the article Agent checks the premise and decides how to write the article.

## Delegation

`run_sub_agent` and each item in `run_sub_agents` accept `overrides` for this invocation:

- `instructions` replaces the saved specialist prompt.
- `outputFormat`, `outputContract`, `allowEmptyOutputKeys` define the output expected by
  this task. Text output has no JSON contract. Explicit configured JSON contracts remain
  enforced; the lead can replace or remove the template contract.
- `model` selects one of the specialist's available models.
- `skillIds`, `mcpServerIds`, `builtinToolNames` select subsets of assigned resources.
- `requiredSkillIds` adjusts template research prerequisites. It cannot grant a Skill.
  The lead must still satisfy the user's explicit evidence requirements.
- `limits` changes local tool-call, round, output and result limits within bounded maxima.
- `timeoutMs` sets a deadline, propagated to nested work and active tools.

The lead sees saved specialist instructions, output requirements, resources and limits
before delegation. Overrides are recorded with invocation history and never update the
saved Agent. Unassigned resources and models remain unavailable. Parallel tasks report
independent outcomes, so one failed assignment does not discard successful sibling work.

## Recovery and direct work

Failures retain raw output, parsed partial data where available, Skill/command references,
MCP activity and tool results. Model-loop failures also retain conversation checkpoints.
The enclosing tool result is saved under an execution-scoped `resultRef`. Failed invocation
history retains raw output rather than replacing it with an empty string.

The lead can:

1. `read_result` to inspect failed work or existing artifacts; use `path`, `offset` and
   `maxChars` for focused or paged reads. Inline previews are bounded, stored data is not.
2. `store_result` to save its own work or a repaired result, then pass it to tools with
   `{$result: resultRef, path: '$.field'}`. Storing data does not validate factual accuracy
   and does not execute external operations.
3. Delegate a focused follow-up with revised instructions and the actual prior context.
   A reference mentioned inside prose is not automatically resolved.
4. `use_sub_agent_tool` to inspect and directly use a directly assigned specialist's
   Skills, MCP or built-in tools without starting its model. Existing resource allowlists,
   command recording and cancellation still apply.

No automatic factual invention, repeated research, or replay of uncertain publications
is performed. External writes still require actual receipts or inspection before retry.
A successful specialist or launch receipt does not establish final delivery; the lead
must assess the user's requested deliverables and report any remaining blockers.

## Budgets and progress

A coordination turn has a shared host budget of 128 invocation/tool starts. Native Skills,
MCP, built-in tools and managed tools all consume it; specialist work stops at the last
16 starts reserved for the lead. External engine invocations consume a start, while their
internal tool execution remains governed by that engine. Native lead defaults are 40
rounds/64 calls, specialists 20 rounds/32 calls; explicit bounded limits may override these.
Round reminders begin around 70% of the local round budget. Tool results report the shared
remaining budget. At local exhaustion the Gateway explicitly disables tool choice for the
final answer. These are execution ceilings, not a guarantee that any model will finish a
business task successfully.

Progress summarizes the latest specialist outcome while retaining active parallel work.
Historical failed attempts stay in audit records; a recovered failure is not repeated as
an outstanding failure in the current progress summary. No new product UI fields are added.

These changes apply to new coordination turns after the updated API starts; they do not
rewrite historical records or restart cancelled tasks.
