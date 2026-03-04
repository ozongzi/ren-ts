use super::{PickleObject, PickleValue};

/// Type-guard: is this a PickleObject?
pub fn is_object(v: &PickleValue) -> bool {
    matches!(v, PickleValue::Object(_))
}

/// Get a field from a PickleObject by name.
pub fn get_field<'a>(v: &'a PickleValue, key: &str) -> Option<&'a PickleValue> {
    v.as_object()?.fields.get(key)
}

/// Return the short class name (everything after the last '.').
/// e.g. "renpy.ast.Say" → "Say"
pub fn short_class(obj: &PickleObject) -> &str {
    match obj.class_name.rfind('.') {
        Some(i) => &obj.class_name[i + 1..],
        None => &obj.class_name,
    }
}

/// Coerce a PickleValue to &str, or None.
pub fn as_str(v: &PickleValue) -> Option<&str> {
    match v {
        PickleValue::String(s) => Some(s),
        _ => None,
    }
}

/// Coerce a PickleValue to String (also handles Bytes as UTF-8).
pub fn as_string(v: &PickleValue) -> Option<String> {
    match v {
        PickleValue::String(s) => Some(s.clone()),
        PickleValue::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        _ => None,
    }
}

/// Coerce a PickleValue to f64.
pub fn as_number(v: &PickleValue) -> Option<f64> {
    match v {
        PickleValue::Int(n) => Some(*n as f64),
        PickleValue::Float(f) => Some(*f),
        PickleValue::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// Unwrap a List or Tuple into a slice.
pub fn as_list(v: &PickleValue) -> Option<&[PickleValue]> {
    match v {
        PickleValue::List(l) => Some(l),
        PickleValue::Tuple(t) => Some(t),
        _ => None,
    }
}