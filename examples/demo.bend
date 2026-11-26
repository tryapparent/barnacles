import Base

type Pull is Data:
  Pull{number: U32, published: Nat, opened: Nat, merged: Nat, first_commit: Nat, first_ci: Nat,
    checked: Nat, thread_start: Nat, dispatch: Nat}

type Demo is Data:
  Demo{repository: String, sha: String, pulls: List<&2, Pull>, started: Nat,
    allocated: Nat, finished: Nat, call: Nat, result: Nat, reasoning: Nat, pending: Nat}

def pull(number: U32, +published: Nat, cycle: Nat, dispatch: Nat -> Nat) -> Pull:
  +opened = Nat.sub(published, 1800n)
  +merged = Nat.sub(published, 600n)
  Pull{number, published, opened, merged, Nat.sub(opened, 300n), Nat.add(opened, 60n),
    Nat.add(published, 20n), Nat.sub(published, cycle), dispatch(merged)}

def no_dispatch(merged: Nat) -> Nat:
  0n

def release_dispatch(merged: Nat) -> Nat:
  Nat.add(merged, 120n)

def fixtures(+now: Nat) -> Demo:
  +monday = Nat.sub(now, Nat.mod(Nat.add(now, 259200n), 604800n))
  prior = pull(1, Nat.add(Nat.sub(monday, 1209600n), 7200n), 7000n, no_dispatch)
  recent = pull(2, Nat.add(Nat.sub(monday, 604800n), 7200n), 4000n, release_dispatch)
  +started = Nat.sub(now, 3600n)
  Demo{"synthetic/example", String.repeat("a", 40n), prior <> recent <> [], started,
    Nat.add(started, 2n), Nat.add(started, 90n), Nat.add(started, 1n), Nat.add(started, 4n),
    Nat.add(started, 6n), Nat.add(started, 8n)}
