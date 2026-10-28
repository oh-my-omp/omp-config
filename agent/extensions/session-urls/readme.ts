// Text served at session://README: the grammar and the find → read → detail loop.
export const README = `session:// — read other OMP sessions on this machine (read-only, rendered on each read)

FIND A SESSION
  session://find?text=<words>[&project=.|<bucket>|<path>][&max=20]
      sessions whose typed prompts (prompt-history index), title or recap match; JSONL
  session://sessions.jsonl[?q=<jq>]            every session's metadata, newest first; JSONL
  session://here/sessions.jsonl[?q=<jq>]       the current project's sessions
  session://projects/<bucket>/sessions.jsonl   one project (bucket = OMP's encoded cwd directory)
  metadata fields: sid url timeline project cwd title created modified status assistantTurns
                   size recap parent

READ A SESSION   (<id> = any unique id prefix; listed paths below use the full id)
  session://<id>/timeline       active-branch timeline: user, developer, thinking, say, IRC in/out,
                                dispatches and subagent results in full; tool calls one line each
                                as tool(args) status #<result entry> // intent; markers one line
  session://<id>/events.jsonl[?q=<jq>]   the same events as JSONL (fields: sid agent turn t kind entry
                                block line url; text | tool args intent status resultEntry
                                resultChars durMs | from to | children | id status duration)
  session://<id>/entry/<entry-id>   one entry in full; for a tool result: its arguments, intent,
                                    timing and the whole result text
  session://<id>/entry/@<line>      the entry on that physical line of raw.jsonl
  session://<id>/raw.jsonl          the session file itself (read/grep only; no jq)
  session://<id>/agents/            subagents; session://<id>/agents/<AgentId>/{timeline,events.jsonl,entry/…}
  session://<id>/artifacts/<N>      that session's artifact://N; session://<id>/local/<path> its local://
  References to artifact://, agent://, history:// and local:// inside a timeline are already
  rewritten to these session:// URLs.

TIMELINE FORMAT
  Header lines start at column 0: HH:MM:SS <kind> #<entry>[.<block>] …; every body line is
  indented two spaces. "── turn N · …" lines open each user turn (grep '^── turn' for an index);
  "── idle …" marks gaps of 5 minutes or more. Clipped text ends with a pointer to entry/<id>.

FILTER BY TYPE   (timeline and events.jsonl, root sessions and subagents)
  ?type=<filter>                 e.g. session://<id>/timeline?type=thinking,irc
  session://type/<filter>/<path> the same filter as a path prefix, needed under a grep glob
                                 (after a glob segment "?" is glob text): grep path=
                                 session://type/thinking/here/2026-10-2*/*/timeline
  <filter> is a comma list (repeated type= and a prefix plus ?type= all add up):
    kinds   user developer thinking say call irc_out irc_in dispatch subresult exec marker
            (header labels work too: calls, result)
    groups  irc = irc_in,irc_out   subagent = dispatch,subresult   tools = call,exec
            ai = thinking,say,irc_out,dispatch
            speech = user,developer,say,irc_in,irc_out,dispatch,subresult
    call:<tool>     events carrying that tool's call (call:bash; call:task = dispatches, call:write = IRC out)
    marker:<what>   one marker kind (marker:compaction, marker:session-exit)
    -<x> or !<x>    exclude; exclusions alone keep everything else (type=-call,-marker)
  Case-insensitive; "-", "_" and spaces are interchangeable inside a name. Filtered timelines keep
  each turn's full counts in its "── turn" line and print a "filter …" header line; jq on a
  filtered events.jsonl continues pages with the same type.

GREP (walks only this tree, so each session is searched once)
  session://projects/<bucket>/<YYYY-MM-DD>/<full-id>/timeline   and …/agents/<AgentId>/timeline
  session://here/…                                              the current project
  e.g. grep pattern path=session://here/2026-10-2*/*/timeline ; one grep call covers roughly 7 GB
  of session files in its 30 s budget, so narrow by project and date. raw.jsonl is not listed:
  grep it by its full URL when tool output must be searched.

JQ  (?q=<filter>&raw=true&compact=true&offset=N&limit=N; percent-encode & and %)
  session://<id>/events.jsonl?q=select(.kind=="user")|.text&raw=true
  session://<id>/events.jsonl?q=select(.kind=="call" and .status=="error")|{t,tool,args,url}
  session://<id>/events.jsonl?q=select(.tool=="bash")|.args.command&raw=true
  session://<id>/events.jsonl?q=[., inputs]|map(select(.tool))|group_by(.tool)|map({tool:.[0].tool,n:length})
  session://sessions.jsonl?q=select(.cwd|test("omp-config"))|{sid,title,modified}

FROM A HIT TO DETAIL
  timeline hit on a header line   → read session://<id>/entry/<entry-id> (the #id on that line)
  timeline hit on a body line     → read session://<id>/timeline:<line-10>-<line> and take the header above
  raw.jsonl hit at line L         → read session://<id>/entry/@L
  events.jsonl hit                → its url field
`;
