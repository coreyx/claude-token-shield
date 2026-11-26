// Package schemacheck validates JSON documents against the subset of JSON
// Schema (draft 2020-12) that Token Shield's schemas use. It exists so the Go
// test suite can check the shared data files against schemas/ without a
// third-party dependency (tech.md: standard library only).
//
// Supported keywords: type, properties, required, additionalProperties
// (boolean or schema), items, minItems, enum, minimum, exclusiveMinimum,
// minLength, pattern, $ref to "#/$defs/<name>", and $defs. Any other keyword
// is an error, so a schema can't quietly rely on something unchecked.
package schemacheck

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// annotations carry no validation meaning and are ignored.
var annotations = map[string]bool{"$schema": true, "$id": true, "title": true, "description": true, "$defs": true}

// Validate checks doc (JSON text) against schema (JSON text) and returns every
// problem found, each prefixed with its location in doc. An empty result
// means doc is valid.
func Validate(schema, doc []byte) ([]string, error) {
	var s, d any
	if err := json.Unmarshal(schema, &s); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	dec := json.NewDecoder(strings.NewReader(string(doc)))
	// Numbers stay exact so "integer" can be told apart from 1.5.
	dec.UseNumber()
	if err := dec.Decode(&d); err != nil {
		return nil, fmt.Errorf("document: %w", err)
	}
	root, ok := s.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("schema: root must be an object")
	}
	v := &validator{root: root}
	v.check(root, d, "$")
	if v.err != nil {
		return nil, v.err
	}
	return v.problems, nil
}

type validator struct {
	root     map[string]any
	problems []string
	err      error
}

// fail records a problem in the document at path.
func (v *validator) fail(path, format string, args ...any) {
	v.problems = append(v.problems, path+": "+fmt.Sprintf(format, args...))
}

// check validates value at path against schema.
func (v *validator) check(schema map[string]any, value any, path string) {
	if v.err != nil {
		return
	}
	if ref, ok := schema["$ref"].(string); ok {
		target, err := v.resolve(ref)
		if err != nil {
			v.err = err
			return
		}
		v.check(target, value, path)
		return
	}
	// Keywords in a fixed order, so problems come out in a stable order.
	keys := make([]string, 0, len(schema))
	for k := range schema {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if annotations[k] {
			continue
		}
		switch k {
		case "type":
			v.checkType(schema[k], value, path)
		case "properties", "required", "additionalProperties":
			// Handled together below.
		case "items":
			if arr, ok := value.([]any); ok {
				sub, ok := schema[k].(map[string]any)
				if !ok {
					v.err = fmt.Errorf("schema: items must be an object")
					return
				}
				for i, item := range arr {
					v.check(sub, item, fmt.Sprintf("%s[%d]", path, i))
				}
			}
		case "minItems":
			if arr, ok := value.([]any); ok && float64(len(arr)) < number(schema[k]) {
				v.fail(path, "needs at least %v items", schema[k])
			}
		case "enum":
			v.checkEnum(schema[k], value, path)
		case "minimum":
			if n, ok := asNumber(value); ok && n < number(schema[k]) {
				v.fail(path, "must be >= %v", schema[k])
			}
		case "exclusiveMinimum":
			if n, ok := asNumber(value); ok && n <= number(schema[k]) {
				v.fail(path, "must be > %v", schema[k])
			}
		case "minLength":
			if s, ok := value.(string); ok && float64(utf8.RuneCountInString(s)) < number(schema[k]) {
				v.fail(path, "must be at least %v characters", schema[k])
			}
		case "pattern":
			if s, ok := value.(string); ok {
				re, err := regexp.Compile(fmt.Sprint(schema[k]))
				if err != nil {
					v.err = fmt.Errorf("schema: pattern: %w", err)
					return
				}
				if !re.MatchString(s) {
					v.fail(path, "must match %s", schema[k])
				}
			}
		default:
			v.err = fmt.Errorf("schema: keyword %q is not supported by schemacheck", k)
			return
		}
	}
	if obj, ok := value.(map[string]any); ok {
		v.checkObject(schema, obj, path)
	}
}

// checkObject applies properties, required and additionalProperties.
func (v *validator) checkObject(schema map[string]any, obj map[string]any, path string) {
	props, _ := schema["properties"].(map[string]any)
	if req, ok := schema["required"].([]any); ok {
		for _, r := range req {
			if _, present := obj[fmt.Sprint(r)]; !present {
				v.fail(path, "missing required property %q", r)
			}
		}
	}
	names := make([]string, 0, len(obj))
	for k := range obj {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, name := range names {
		child := path + "." + name
		if sub, ok := props[name].(map[string]any); ok {
			v.check(sub, obj[name], child)
			continue
		}
		switch extra := schema["additionalProperties"].(type) {
		case bool:
			if !extra {
				v.fail(child, "is not allowed")
			}
		case map[string]any:
			v.check(extra, obj[name], child)
		}
	}
}

// checkType applies a single "type" name.
func (v *validator) checkType(want, value any, path string) {
	name := fmt.Sprint(want)
	ok := false
	switch name {
	case "object":
		_, ok = value.(map[string]any)
	case "array":
		_, ok = value.([]any)
	case "string":
		_, ok = value.(string)
	case "boolean":
		_, ok = value.(bool)
	case "null":
		ok = value == nil
	case "number":
		_, ok = asNumber(value)
	case "integer":
		if n, isNum := value.(json.Number); isNum {
			_, err := n.Int64()
			ok = err == nil
		}
	default:
		v.err = fmt.Errorf("schema: type %q is not supported", name)
		return
	}
	if !ok {
		v.fail(path, "must be of type %s", name)
	}
}

// checkEnum requires value to equal one of the listed scalars.
func (v *validator) checkEnum(list, value any, path string) {
	options, ok := list.([]any)
	if !ok {
		v.err = fmt.Errorf("schema: enum must be an array")
		return
	}
	got := fmt.Sprint(value)
	for _, o := range options {
		if fmt.Sprint(o) == got {
			return
		}
	}
	v.fail(path, "must be one of %v", options)
}

// resolve follows a "#/$defs/<name>" reference.
func (v *validator) resolve(ref string) (map[string]any, error) {
	const prefix = "#/$defs/"
	if !strings.HasPrefix(ref, prefix) {
		return nil, fmt.Errorf("schema: $ref %q is not supported", ref)
	}
	defs, _ := v.root["$defs"].(map[string]any)
	target, ok := defs[strings.TrimPrefix(ref, prefix)].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("schema: $ref %q not found", ref)
	}
	return target, nil
}

// asNumber reads a decoded JSON number.
func asNumber(value any) (float64, bool) {
	n, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil
}

// number reads a numeric keyword value from the schema.
func number(value any) float64 {
	f, _ := value.(float64)
	return f
}
