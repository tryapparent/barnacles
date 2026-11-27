import Base

def duration(range: String) -> Nat:
  Bool.pick(Nat,String.eq(range,"7d"),604800000n,86400000n)

def start(range: String, to: Nat) -> Nat:
  Nat.sub(to,duration(range))
