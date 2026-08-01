const defineTestGlobal = (name: string, value: unknown): void => {
  if (!(name in globalThis)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  }
};

class TestDOMMatrix {}
class TestImageData {}
class TestPath2D {}

defineTestGlobal("DOMMatrix", TestDOMMatrix);
defineTestGlobal("ImageData", TestImageData);
defineTestGlobal("Path2D", TestPath2D);
