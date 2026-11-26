import Base

def repository_chars(chars: List<&2, Char>) -> Bool:
  match chars:
    case []: True{}
    case +head <> tail:
      Bool.and(Bool.or(Char.is_alpha(head), Bool.or(Char.is_digit(head),
        String.contains("_.-", String.from_list([head])))), repository_chars(tail))

def repository_part(+word: String) -> Bool:
  Bool.and(Bool.not(String.is_empty(word)), Bool.and(Bool.not(String.eq(word, ".")),
    Bool.and(Bool.not(String.eq(word, "..")), repository_chars(String.to_list(word)))))

def valid_parts(parts: List<&2, String>) -> Bool:
  match parts:
    case [owner, name]: Bool.and(repository_part(owner), repository_part(name))
    case _: False{}

def valid(value: String) -> Bool:
  valid_parts(String.split(value, '/'))

def normalized(+value: String) -> String:
  Bool.pick(String, Bool.and(Nat.is_le(String.length(value), 128n), valid(value)), String.to_lower(value), "")
