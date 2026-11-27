import Base

type ToolInput is Data:
  Bottlenecks{}
  Thread{}
  Timeline{}
  Charts{}

type PlowTool is Data:
  McpTool{name: String, description: String, input: ToolInput}

def tools() -> List<&2, PlowTool>:
  McpTool{"get_plow_bottlenecks",
    "Read Plow's latest 24-hour delivery analysis. Use analyzedAt, window, and coverage when reporting priorities. Follow thread IDs from this response for drill-down.",
    Bottlenecks{}} <>
  McpTool{"get_plow_thread",
    "Read the recorded bottlenecks, costs, and source coverage for a thread ID returned by get_plow_bottlenecks.",
    Thread{}} <>
  McpTool{"get_plow_timeline",
    "Read the dashboard activity timeline with UTC starts, elapsed seconds, anonymous thread intervals, and recorded failures. Report the observation time.",
    Timeline{}} <>
  McpTool{"get_plow_charts",
    "Read the dashboard's Where time went and Agent work share for 24 hours or seven days. Chart durations use milliseconds and trend share uses basis points.",
    Charts{}} <> []
