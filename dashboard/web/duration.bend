import Base

def part(+value: Nat, unit: String) -> String:
  Bool.pick(String, Nat.is_eq(value, 0n), "", String.append(Nat.show(value), unit))

def elapsed_label(ms: Nat, negative: Bool, signed: Bool) -> String:
  +minutes = Nat.div(Nat.add(ms, 30000n), 60000n)
  +days = Nat.div(minutes, 1440n)
  +hours = Nat.mod(Nat.div(minutes, 60n), 24n)
  +remainder = Nat.mod(minutes, 60n)
  +sign = Bool.pick(String, signed, Bool.pick(String, negative, "−", "+"), "")
  Bool.pick(String, Nat.is_eq(minutes, 0n), "0M",
    String.append(sign, String.append(part(days, "D"), String.append(part(hours, "H"), part(remainder, "M")))))

def milliseconds_fraction(+remainder: Nat) -> String:
  hundreds = Nat.div(remainder, 100n)
  +tens = Nat.mod(Nat.div(remainder, 10n), 10n)
  +ones = Nat.mod(remainder, 10n)
  String.concat([".", Nat.show(hundreds),
    Bool.pick(String, Bool.and(Nat.is_eq(tens, 0n), Nat.is_eq(ones, 0n)), "", Nat.show(tens)),
    Bool.pick(String, Nat.is_eq(ones, 0n), "", Nat.show(ones))])

def process_label(+microseconds: Nat) -> String:
  +remainder = Nat.mod(microseconds, 1000n)
  String.concat([Nat.show(Nat.div(microseconds, 1000n)),
    Bool.pick(String, Nat.is_eq(remainder, 0n), "", milliseconds_fraction(remainder)), " ms"])
