import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

describe('example test suite', () => {
  it('renders a simple element using React.createElement', () => {
    const el = React.createElement('div', { 'data-testid': 'greet' }, 'Hello Vitest');
    render(el);
    expect(screen.getByTestId('greet')).toHaveTextContent('Hello Vitest');
  });

  it('works with DOM APIs directly', () => {
    const container = document.createElement('div');
    container.textContent = 'Direct DOM';
    document.body.appendChild(container);
    expect(document.body.textContent).toContain('Direct DOM');
    document.body.removeChild(container);
  });
});
