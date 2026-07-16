export function renderRoomName(target, name) {
  target.textContent = String(name ?? '');
  return target;
}

export function appendTextElement(parent, tagName, className, text) {
  const element = parent.ownerDocument.createElement(tagName);
  if (className) element.className = className;
  element.textContent = String(text ?? '');
  parent.appendChild(element);
  return element;
}

export function replaceTextList(parent, values, builder) {
  if (!Array.isArray(values)) throw new TypeError('values must be an array');
  if (typeof builder !== 'function') throw new TypeError('builder must be a function');
  const children = values.map((value, index) => builder(value, index));
  parent.replaceChildren(...children);
  return children;
}
