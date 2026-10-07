import { describe, it, expect } from 'vitest';
import { analyzeFile, ImportResolver, parseSource } from '../src/index.js';
import type { TreeNode } from '@codefront/schema';

const fns = (n: TreeNode, out: Record<string, number | undefined> = {}) => { if (n.kind === 'function') out[n.name] = n.cx; n.children?.forEach((c) => fns(c, out)); return out; };
const kinds = (n: TreeNode): string[] => [n.kind + ':' + n.name, ...(n.children ?? []).flatMap(kinds)];

describe('Go', () => {
  const src = `package main

import (
\t"fmt"
\t"example.com/app/util"
)

// Server serves.
type Server struct{ n int }

func (s *Server) Start(x int) int {
\tif x > 0 && s.n > 0 { // +1 +1
\t\tfor i := 0; i < x; i++ { // +2
\t\t\tfmt.Println(i)
\t\t}
\t} else if x < 0 { // +1
\t\treturn -1
\t} else { // +1
\t\treturn 0
\t}
\treturn util.Do(x)
}

func helper() {
\tswitch {
\tcase true:
\t}
}
`;
  it('splits functions/methods with complexity and imports', async () => {
    const a = await analyzeFile('main.go', src);
    expect(a.parsed).toBe(true);
    expect(fns(a.node)).toEqual({ 'Server.Start': 6, helper: 1 });
    expect(a.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['fmt', 'example.com/app/util']));
    expect((await parseSource(src, 'go')).comments.length).toBe(5);
  });
});

describe('Java', () => {
  const src = `package com.acme.app;

import com.acme.util.Strings;
import java.util.*;

/** Doc */
public class Foo {
  private int n;
  public Foo() { n = 1; }
  int run(int x) {
    try {
      while (x > 0) { x--; }          // +1
    } catch (Exception e) {           // +1
      return x > 1 ? 1 : 0;           // +2 (nested)
    }
    if (x == 0 || x == 1) return 1;   // +1 +1
    return 0;
  }
  static class Inner { void go() {} }
}
`;
  it('classes -> methods, complexity, imports', async () => {
    const a = await analyzeFile('src/main/java/com/acme/app/Foo.java', src);
    expect(a.parsed).toBe(true);
    const k = kinds(a.node);
    expect(k).toContain('class:Foo');
    expect(fns(a.node).run).toBe(6);
    expect(fns(a.node).Foo).toBe(0);
    expect(a.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['com.acme.util.Strings', 'java.util.*']));
  });
  it('resolves package imports to file path suffixes', () => {
    const r = new ImportResolver('/nonexistent', ['src/main/java/com/acme/app/Foo.java', 'src/main/java/com/acme/util/Strings.java']);
    expect(r.resolve('src/main/java/com/acme/app/Foo.java', { spec: 'com.acme.util.Strings' })).toBe('src/main/java/com/acme/util/Strings.java');
  });
});

describe('C#', () => {
  const src = `using System;
using Acme.Util;

namespace Acme.App
{
    // a class
    public class Svc
    {
        public int Run(int x)
        {
            foreach (var i in new[] { 1 }) { }   // +1
            if (x > 0) { return 1; }            // +1
            else { return x ?? 0; }             // +1
        }
    }
}
`;
  it('namespace -> class -> method', async () => {
    const a = await analyzeFile('App/Svc.cs', src.replace('x ?? 0', '0'));
    expect(a.parsed).toBe(true);
    expect(kinds(a.node)).toContain('class:Svc');
    expect(fns(a.node)).toEqual({ Run: 3 });
    expect(a.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['System', 'Acme.Util']));
  });
  it('resolves namespaces to directories', () => {
    const r = new ImportResolver('/nonexistent', ['App/Svc.cs', 'Acme/Util/Strings.cs']);
    expect(r.resolve('App/Svc.cs', { spec: 'Acme.Util' })).toBe('Acme/Util/Strings.cs');
  });
});

describe('Rust', () => {
  const src = `use crate::util::helpers;
mod net;

/// docs
pub struct P { x: i32 }

impl P {
    pub fn new() -> Self { P { x: 0 } }
    fn go(&self, v: Option<i32>) -> i32 {
        match v {                       // +1
            Some(n) if n > 0 => {
                if n > 10 { 1 } else { 2 }   // +2 (nested) +1
            }
            _ => loop { break 0; },     // +2 (nested)
        }
    }
}

fn main() { let f = |a: i32| a + 1; }
`;
  it('impl blocks -> methods, complexity, use/mod imports', async () => {
    const a = await analyzeFile('src/lib.rs', src);
    expect(a.parsed).toBe(true);
    expect(kinds(a.node)).toContain('class:impl P');
    expect(fns(a.node)).toEqual({ new: 0, go: 6, main: 0 });
    expect(a.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['crate::util::helpers', 'mod:net']));
    const r = new ImportResolver('/nonexistent', ['src/lib.rs', 'src/net.rs', 'src/util/helpers.rs']);
    expect(r.resolve('src/lib.rs', { spec: 'mod:net' })).toBe('src/net.rs');
    expect(r.resolve('src/lib.rs', { spec: 'crate::util::helpers' })).toBe('src/util/helpers.rs');
  });
});
