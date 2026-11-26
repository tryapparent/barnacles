import Base

type Totals is Data:
  Sums{n: Nat, x: Nat, y: F32, xx: Nat, xy: F32, yy: F32}

type Groups is Data:
  Empty{}
  Group{key: String, sum: Totals, rest: Groups}

type Fit is Data:
  Fit{n: Nat, commands: Nat, contexts: Nat, xx: F32, xy: F32, yy: F32}

type Model is Data:
  Model{files: Groups, git: Groups, builds: Groups, pushes: Groups}

type Estimate is Data:
  Estimate{name: String, supported: Bool, seconds: F32, total: F32, error: F32, samples: Nat}

def empty_model() -> Model:
  Model{Empty{}, Empty{}, Empty{}, Empty{}}

def add_sums(sums: Totals, +count: Nat, +seconds: F32) -> Totals:
  match sums:
    case Sums{n, sx, sy, xx, xy, yy}:
      Sums{Nat.add(n, 1n), Nat.add(sx, count), F32.add(sy, seconds),
        Nat.add(xx, Nat.mul(count, count)), F32.add(xy, F32.mul(F32.from_nat(count), seconds)),
        F32.add(yy, F32.mul(seconds, seconds))}

def observe(groups: Groups, +key: String, +count: Nat, +seconds: F32) -> Groups:
  match groups:
    case Empty{}:
      Group{key, add_sums(Sums{0n, 0n, 0.0, 0n, 0.0, 0.0}, count, seconds), Empty{}}
    case Group{+group, +sum, +rest}:
      Bool.pick(Groups, String.eq(key, group), Group{group, add_sums(sum, count, seconds), rest},
        Group{group, sum, observe(rest, key, count, seconds)})

def context(scope: String, a: Nat, b: Nat, c: Nat) -> String:
  String.append(scope, String.append(":", String.append(Nat.show(a), String.append(":", String.append(Nat.show(b),
    String.append(":", Nat.show(c)))))))

def model_observe(model: Model, +scope: String, +files: Nat, +git: Nat, +builds: Nat, +pushes: Nat, +seconds: F32) -> Model:
  match model:
    case Model{f, g, b, p}:
      Model{observe(f, context(scope, git, builds, pushes), files, seconds),
        observe(g, context(scope, files, builds, pushes), git, seconds),
        observe(b, context(scope, files, git, pushes), builds, seconds),
        observe(p, context(scope, files, git, builds), pushes, seconds)}

def model_receipt(model: Model, +instance: String, session: String, files: Nat, git: Nat, builds: Nat, pushes: Nat,
                  seconds: F32) -> Model:
  +scope = String.append(Nat.show(String.length(instance)), String.append(":", String.append(instance, session)))
  model_observe(model, scope, files, git, builds, pushes, seconds)

def merge_fit(fit: Fit, n: Nat, commands: Nat, xx: F32, xy: F32, yy: F32) -> Fit:
  match fit:
    case Fit{sn, sc, sg, sxx, sxy, syy}:
      Fit{Nat.add(sn, n), Nat.add(sc, commands), Nat.add(sg, 1n),
        F32.add(sxx, xx), F32.add(sxy, xy), F32.add(syy, yy)}

def add_context(+fit: Fit, sums: Totals) -> Fit:
  match sums:
    case Sums{+n, +x, +y, xx, xy, yy}:
      +size = F32.from_nat(n)
      +variance = F32.div(F32.from_nat(Nat.sub(Nat.mul(n, xx), Nat.mul(x, x))), size)
      Bool.pick(Fit, F32.is_gt(variance, 0.0),
        merge_fit(fit, n, x, variance, F32.sub(xy, F32.div(F32.mul(F32.from_nat(x), y), size)),
          F32.sub(yy, F32.div(F32.mul(y, y), size))), fit)

def summarize(groups: Groups, fit: Fit) -> Fit:
  match groups:
    case Empty{}: fit
    case Group{key, sum, rest}: summarize(rest, add_context(fit, sum))

def estimate(name: String, fit: Fit) -> Estimate:
  match fit:
    case Fit{+n, commands, +contexts, +xx, +xy, yy}:
      +df = Nat.sub(Nat.sub(n, contexts), 1n)
      +slope = F32.div(F32.max(0.0, xy), F32.max(1.0e-6, xx))
      residual = F32.max(0.0, F32.add(F32.sub(yy, F32.mul(2.0, F32.mul(slope, xy))), F32.mul(F32.mul(slope, slope), xx)))
      supported = Bool.and(Nat.is_le(5n, n), Bool.and(Nat.is_lt(0n, df), F32.is_gt(xx, 0.0)))
      Estimate{name, supported, slope, F32.mul(slope, F32.from_nat(commands)),
        F32.sqrt(F32.div(residual, F32.max(1.0e-6, F32.mul(F32.from_nat(df), xx)))), n}

def estimate_group(name: String, groups: Groups) -> Estimate:
  estimate(name, summarize(groups, Fit{0n, 0n, 0n, 0.0, 0.0, 0.0}))

def model_estimates(model: Model) -> List<&2, Estimate>:
  match model:
    case Model{files, git, builds, pushes}:
      estimate_group("File inspection", files) <> estimate_group("Git inspection", git) <>
        estimate_group("Rust build", builds) <> estimate_group("Git push", pushes) <> []
