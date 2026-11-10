import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { ModelParametersFields } from './model-parameters-fields';

afterEach(cleanup);

describe('model use-site parameters', () => {
  it('loads effort and fast selections and emits only valid request parameters', () => {
    const onChange = vi.fn();
    render(<ModelParametersFields value={{ reasoningEffort: 'high', serviceTier: 'fast' }} protocol="openai/responses" onChange={onChange} />);
    expect(screen.getByRole('combobox', { name: '推理强度' })).toHaveTextContent('high');
    expect(screen.getByRole('combobox', { name: '服务档位' })).toHaveTextContent('fast');
    const json = screen.getByRole('textbox', { name: '请求参数（JSON）' });
    fireEvent.change(json, { target: { value: '{"temperature": 0.4}' } });
    fireEvent.blur(json);
    expect(onChange).toHaveBeenLastCalledWith({ reasoningEffort: 'high', serviceTier: 'fast', requestBody: { temperature: 0.4 } });
    onChange.mockClear();
    fireEvent.change(json, { target: { value: '{"model":"other"}' } });
    fireEvent.blur(json);
    expect(screen.getByRole('alert')).toBeVisible();
    expect(json).toBeInvalid();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows protocol JSON for System One and only supported controls for execution engines', () => {
    const view = render(<ModelParametersFields value={{}} protocol="typesafe/systemone" onChange={vi.fn()} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    view.rerender(<ModelParametersFields value={{}} runtime="codex" onChange={vi.fn()} />);
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
