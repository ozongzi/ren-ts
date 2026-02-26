// fixtures for lexer string handling tests
// Contains various string literal forms and escape sequences,
// plus a couple of adjacent tokens to ensure proper token boundaries.

label strings_test:
  // Simple strings (double and single)
  say "Hello, world"
  intro 'Welcome to the lexer tests'

  // Escaped characters inside strings
  escaped_newline "Line1\nLine2\tTabbed\rCR"
  escaped_quotes_double "She said: \"Hello\" and left"
  escaped_quotes_single 'It\'s a lovely day'

  // Backslashes and path-like strings
  windows_path "C:\\Program Files\\App"
  backslash_only "\\\\"

  // Mixed content: identifier, equals, number, string
  title = "Test Suite 1"
  version = 1.0

  // Hex colour tokens — should be recognized as HexColor by lexer
  color_short = #abc
  color_long = #A1B2C3

  // Triple-question special identifier
  mystery ??? :: reveal

  // A string containing punctuation and brackets
  complex "Comma, colon: semicolon; parentheses (ok) [fine] {curly}"

  // Full-width pipe (U+FF5C) — tokenizer should treat it as '|'
  separator "a"｜"b"

  // Unterminated string scenario (EOF) — useful for robustness tests
  // Note: this fixture intentionally leaves the next string unterminated.
  unterminated "This string does not have a closing quote
