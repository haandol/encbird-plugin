"""Check local file targets in repository and packaged Markdown without network access."""
import html
from html.parser import HTMLParser
import posixpath
import re
from urllib.parse import unquote, urlsplit


def prose_only(text):
    lines = []
    fence = None
    for line in text.splitlines(keepends=True):
        match = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if fence:
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence):
                fence = None
            lines.append('\n' if line.endswith('\n') else '')
            continue
        if match:
            fence = match[1]
            lines.append('\n' if line.endswith('\n') else '')
            continue
        lines.append(re.sub(r'(`+)(?!`)(.*?)\1(?!`)', lambda m: ' ' * len(m[0]), line))
    return ''.join(lines)


def destination(text, start):
    while start < len(text) and text[start].isspace():
        start += 1
    if start >= len(text):
        return None
    if text[start] == '<':
        end = text.find('>', start + 1)
        return text[start + 1:end] if end != -1 else None
    depth = 0
    result = []
    while start < len(text):
        char = text[start]
        if char == '\\' and start + 1 < len(text):
            result.append(text[start:start + 2])
            start += 2
            continue
        if char == '(':
            depth += 1
        elif char == ')':
            if depth == 0:
                break
            depth -= 1
        elif char.isspace() and depth == 0:
            break
        result.append(char)
        start += 1
    return ''.join(result)


def label(value):
    return ' '.join(value.split()).casefold()


class HtmlLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1
        if self.hidden:
            return
        for key, value in attrs:
            if key in ('href', 'src') and value is not None:
                self.links.append((self.getpos()[0], value))

    def handle_endtag(self, tag):
        if tag in ('script', 'style') and self.hidden:
            self.hidden -= 1


def bracket_links(text, definitions, definition_lines=()):
    position = 0
    while position < len(text):
        if text[position] == '\\':
            position += 2
            continue
        if text[position] != '[':
            position += 1
            continue
        start = position
        depth = 1
        position += 1
        while position < len(text) and depth:
            if text[position] == '\\':
                position += 2
                continue
            if text[position] == '[':
                depth += 1
            elif text[position] == ']':
                depth -= 1
            position += 1
        if depth:
            break
        line = text.count('\n', 0, start) + 1
        if line in definition_lines:
            continue
        name = text[start + 1:position - 1]
        if '[' in name:
            for child_line, target in bracket_links(name, definitions):
                yield line + child_line - 1, target
        next_at = position
        if next_at < len(text) and text[next_at] == '(':
            target = destination(text, next_at + 1)
            if target is not None:
                yield line, target
        elif next_at < len(text) and text[next_at] == '[':
            end = text.find(']', next_at + 1)
            if end != -1:
                position = end + 1
                reference = label(text[next_at + 1:end] or name)
                if reference in definitions:
                    yield line, definitions[reference]
        elif label(name) in definitions:
            yield line, definitions[label(name)]


def markdown_links(text):
    text = prose_only(text)
    definitions = {}
    definition_lines = set()
    for index, line in enumerate(text.splitlines(), 1):
        match = re.match(r'^ {0,3}\[([^]\n]+)\]:\s*(.*)$', line)
        if match:
            target = destination(match[2], 0)
            if target is not None:
                definitions.setdefault(label(match[1]), target)
                definition_lines.add(index)
    yield from bracket_links(text, definitions, definition_lines)
    parser = HtmlLinks()
    parser.feed(text)
    yield from parser.links


def local_target(source, value):
    value = html.unescape(value.strip())
    value = re.sub(r'\\([!"#$%&\'()*+,\-./:;<=>?@\[\]\\^_`{|}~])', r'\1', value)
    if re.match(r'^[A-Za-z]:[\\/]', value):
        raise ValueError('absolute file path')
    parsed = urlsplit(value)
    if parsed.scheme.casefold() == 'file':
        raise ValueError('absolute file URL')
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    path = unquote(parsed.path)
    if path.startswith('/') or '\\' in path or any(ord(char) < 32 for char in path):
        raise ValueError('absolute, control-character or backslash file path')
    target = posixpath.normpath(posixpath.join(posixpath.dirname(source), path))
    if target == '..' or target.startswith('../'):
        raise ValueError('file target escapes the document root')
    return target


def validate_documents(files, exclude_sources=()):
    names = set(files)
    problems = []
    count = 0
    for name, data in sorted(files.items()):
        if not name.lower().endswith('.md') or name in exclude_sources:
            continue
        text = data.decode('utf-8') if isinstance(data, bytes) else data
        for line, url in markdown_links(text):
            try:
                target = local_target(name, url)
            except ValueError as error:
                problems.append({'file': name, 'line': line, 'target': url, 'reason': str(error)})
                continue
            if target is None:
                continue
            count += 1
            directory = target == '.' or any(path.startswith(target.rstrip('/') + '/') for path in names)
            if target not in names and not directory:
                problems.append({'file': name, 'line': line, 'target': url, 'resolved': target, 'reason': 'missing file target'})
    return {'checked': count, 'problems': problems}


def require_document_links(files, exclude_sources=()):
    result = validate_documents(files, exclude_sources)
    if result['problems']:
        detail = '\n'.join(f"{item['file']}:{item['line']} -> {item['target']}: {item['reason']}" for item in result['problems'])
        raise ValueError('Unresolved document links:\n' + detail)
    return result
