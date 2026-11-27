import Base

type PlowTool is Data:
  McpTool{name: String, description: String, thread: Bool}

def tools() -> List<&2, PlowTool>:
  McpTool{"get_plow_bottlenecks",
    "Read Plow's latest 24-hour delivery analysis. Use analyzedAt, window, and coverage when reporting priorities. Follow thread IDs from this response for drill-down.",
    False{}} <>
  McpTool{"get_plow_thread",
    "Read the recorded bottlenecks, costs, and source coverage for a thread ID returned by get_plow_bottlenecks.",
    True{}} <> []
