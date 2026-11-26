import Base

def known_interval(+start: U32, end: U32) -> Bool:
  Bool.and(U32.is_ne(start, 0), U32.is_le(start, end))

def has_prior_execution(created: U32, +started: U32) -> Bool:
  Bool.and(U32.is_ne(started, 0), U32.is_lt(started, created))

def queue_known(+created: U32, started: U32, completed: U32, allocation: U32) -> U32:
  match allocation:
    case 1:
      Bool.to_u32(known_interval(created, started))
    case 2:
      Bool.to_u32(Bool.and(Bool.not(has_prior_execution(created, started)), known_interval(created, completed)))
    case _:
      0

def execution_known(created: U32, +started: U32, completed: U32, allocation: U32) -> U32:
  match allocation:
    case 1:
      Bool.to_u32(Bool.and(Bool.not(has_prior_execution(created, started)), known_interval(started, completed)))
    case _:
      0

def step_known(+start: U32, +end: U32, job_start: U32, job_end: U32) -> U32:
  Bool.to_u32(Bool.and(known_interval(start, end), Bool.and(U32.is_le(job_start, start), U32.is_le(end, job_end))))
