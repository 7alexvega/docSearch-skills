Document Title Set With Setext
==============================

This opening paragraph sits under a setext H1. A parser that only matches ATX
headings would treat this entire document as headerless and chunk it blindly.

Second Level Via Setext
-----------------------

Text under a setext H2. The underline itself must not be counted as content and
must not be mistaken for a thematic break.

## Code fences containing heading-like text

The block below contains lines that look exactly like Markdown headings. None
of them are headings, and a parser that treats them as such will produce a tree
whose line ranges are wrong for the rest of the document.

```markdown
# This Is Not A Heading
## Neither Is This

Some sample content that a user might paste.
```

~~~
# Tilde-fenced, also not a heading
~~~

## Repeated Heading

First occurrence. Two sibling sections share this exact heading text, so their
node ids must be disambiguated rather than colliding.

## Repeated Heading

Second occurrence, with different content. If both nodes receive the same
node_id, cross-reference resolution silently jumps to the wrong one.

## Inline code with backticks

A paragraph mentioning ``a ` b`` inline should not open a fence.

## Trailing section ###

The heading above uses a closing hash sequence, which is decoration and must be
stripped from the heading text.
