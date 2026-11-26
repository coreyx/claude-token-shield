package schemacheck

import (
	"strings"
	"testing"
)

const schema = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "test",
  "type": "object",
  "required": ["n", "list"],
  "additionalProperties": false,
  "properties": {
    "n": { "type": "integer", "minimum": 1 },
    "x": { "type": "number", "exclusiveMinimum": 0 },
    "s": { "type": "string", "minLength": 2, "pattern": "^[a-z]+$" },
    "e": { "type": "string", "enum": ["a", "b"] },
    "b": { "type": "boolean" },
    "z": { "type": "null" },
    "list": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/item" } },
    "map": { "type": "object", "additionalProperties": { "type": "integer" } }
  },
  "$defs": { "item": { "type": "object", "required": ["k"], "properties": { "k": { "type": "string" } } } }
}`

// TestValidate covers each supported keyword with a passing and a failing document.
func TestValidate(t *testing.T) {
	cases := []struct {
		name string
		doc  string
		want []string
	}{
		{"valid", `{"n":1,"x":0.5,"s":"ab","e":"a","b":true,"z":null,"list":[{"k":"v"}],"map":{"a":1}}`, nil},
		{"missing required", `{"list":[{"k":"v"}]}`, []string{`$: missing required property "n"`}},
		{"extra property", `{"n":1,"list":[{"k":"v"}],"q":1}`, []string{"$.q: is not allowed"}},
		{"integer", `{"n":1.5,"list":[{"k":"v"}]}`, []string{"$.n: must be of type integer"}},
		{"minimum", `{"n":0,"list":[{"k":"v"}]}`, []string{"$.n: must be >= 1"}},
		{"exclusiveMinimum", `{"n":1,"x":0,"list":[{"k":"v"}]}`, []string{"$.x: must be > 0"}},
		{"number type", `{"n":1,"x":"1","list":[{"k":"v"}]}`, []string{"$.x: must be of type number"}},
		{"minLength", `{"n":1,"s":"a","list":[{"k":"v"}]}`, []string{"$.s: must be at least 2 characters"}},
		{"pattern", `{"n":1,"s":"AB","list":[{"k":"v"}]}`, []string{"$.s: must match ^[a-z]+$"}},
		{"enum", `{"n":1,"e":"c","list":[{"k":"v"}]}`, []string{"$.e: must be one of [a b]"}},
		{"boolean", `{"n":1,"b":"yes","list":[{"k":"v"}]}`, []string{"$.b: must be of type boolean"}},
		{"null", `{"n":1,"z":0,"list":[{"k":"v"}]}`, []string{"$.z: must be of type null"}},
		{"minItems", `{"n":1,"list":[]}`, []string{"$.list: needs at least 1 items"}},
		{"array type", `{"n":1,"list":{}}`, []string{"$.list: must be of type array"}},
		{"ref", `{"n":1,"list":[{}]}`, []string{`$.list[0]: missing required property "k"`}},
		{"additional schema", `{"n":1,"list":[{"k":"v"}],"map":{"a":"x"}}`, []string{"$.map.a: must be of type integer"}},
		{"object type", `[]`, []string{"$: must be of type object"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Validate([]byte(schema), []byte(c.doc))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(got, "\n") != strings.Join(c.want, "\n") {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}

// TestValidateSchemaErrors checks that an unusable schema or document is an error, not a pass.
func TestValidateSchemaErrors(t *testing.T) {
	cases := []struct{ name, schema, doc, want string }{
		{"unsupported keyword", `{"anyOf":[]}`, `{}`, `keyword "anyOf" is not supported`},
		{"bad oneOf", `{"oneOf":{}}`, `1`, "oneOf must be an array"},
		{"bad oneOf entry", `{"oneOf":[1]}`, `1`, "oneOf entries must be objects"},
		{"bad type in list", `{"type":["date"]}`, `1`, `type "date" is not supported`},
		{"bad schema in oneOf", `{"oneOf":[{"anyOf":[]}]}`, `1`, `keyword "anyOf"`},
		{"unsupported type", `{"type":"date"}`, `1`, `type "date" is not supported`},
		{"external ref", `{"$ref":"other.json"}`, `1`, `$ref "other.json" is not supported`},
		{"missing ref", `{"$ref":"#/$defs/x"}`, `1`, `$ref "#/$defs/x" not found`},
		{"bad pattern", `{"pattern":"("}`, `"a"`, "pattern"},
		{"bad enum", `{"enum":"a"}`, `"a"`, "enum must be an array"},
		{"bad items", `{"items":true}`, `[1]`, "items must be an object"},
		{"schema not object", `[]`, `1`, "root must be an object"},
		{"schema not json", `{`, `1`, "schema:"},
		{"document not json", `{}`, `{`, "document:"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Validate([]byte(c.schema), []byte(c.doc))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("got error %v, want one containing %q", err, c.want)
			}
		})
	}
}

// TestValidateExtended covers the keywords the check view's schema uses.
func TestValidateExtended(t *testing.T) {
	const s = `{
  "type": "object",
  "properties": {
    "pair": { "type": "array", "maxItems": 2 },
    "p": { "type": ["number", "null"], "maximum": 1 },
    "k": { "const": "learning" },
    "o": { "oneOf": [{ "type": "null" }, { "type": "string" }] }
  }
}`
	cases := map[string]string{
		`{"pair":[1,2],"p":null,"k":"learning","o":"x"}`: "",
		`{"pair":[1,2,3]}`:  "$.pair: allows at most 2 items",
		`{"p":1.5}`:         "$.p: must be <= 1",
		`{"p":"x"}`:         "$.p: must be of type [number null]",
		`{"k":"estimated"}`: "$.k: must be learning",
		`{"o":1}`:           "$.o: must match exactly one of 2 alternatives (matched 0)",
	}
	for doc, want := range cases {
		got, err := Validate([]byte(s), []byte(doc))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(got, "\n") != want {
			t.Errorf("%s: got %q, want %q", doc, got, want)
		}
	}
}
