import Base
import ../bottleneck.bend as Study

type Thread is Data:
  Thread{id: String, rules: List<&2, String>}

type Target is Data:
  Target{instance: String, thread: String}

type Rank is Data:
  Rank{rule: String, threads: U32, occurrences: U32}

def scoped(+id: String, rules: List<&2, String>) -> List<&2, Study.Finding>:
  match rules:
    case []: []
    case rule <> tail:
      Study.Finding{rule, id, "", "", 0, 0, 0, 0} <> scoped(id, tail)

def aggregate(threads: List<&2, Thread>, totals: Study.RulePatterns) -> Study.RulePatterns:
  match threads:
    case []: totals
    case Thread{id, rules} <> tail:
      aggregate(tail, Study.collect_rule_patterns(scoped(id, rules), totals))

def ranks(patterns: List<&2, Study.RulePattern>) -> List<&2, Rank>:
  match patterns:
    case []: []
    case Study.RulePattern{rule, threads, count, _, _} <> tail:
      Rank{rule, threads, count} <> ranks(tail)

def ranking(threads: List<&2, Thread>) -> List<&2, Rank>:
  ranks(Study.ranked_patterns(aggregate(threads, Study.RulePatterns{Map.new(&2, Bool), Map.new(&2, Study.RulePattern)})))

def select_threads(instances: List<&2, Target>) -> List<&2, Target>:
  List.take(&2, Target, instances, 50n)

def public_rule(finding: Study.Finding) -> String:
  match finding:
    case Study.Finding{rule, _, _, _, _, _, _, _}: rule

def refresh_needed(stored: String, observed: String) -> Bool:
  Bool.not(String.eq(stored, observed))
