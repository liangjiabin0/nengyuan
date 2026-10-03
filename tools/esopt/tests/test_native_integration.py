import os, json, math
from esopt_agent import service, native_backend, guide
from esopt_agent.highspy_backend import solve_dcopf_case

assert native_backend.installation()['ready'], native_backend.installation()
results = {}
for name in ('diet', 'knapsack'):
    template = guide.TEMPLATES[name]
    result = service.solve_model(template['model'])
    assert result['backend'] == 'esopt-native' and result['ok'], result
    assert math.isclose(result['objective'], {'diet': 7.5, 'knapsack': 7}[name], abs_tol=1e-7), result
    results[name] = result
spec = {'variables': [{'name': 'x', 'lb': None, 'ub': 10}], 'constraints': [{'expr': 'x >= -2'}], 'objective': {'expr': 'min x'}}
result = service.solve_model(spec)
assert result['objective'] == -2, result
results['free_lower_bound'] = result
spec['constraints'] = [{'terms': [{'var': 'x', 'coef': 1}], 'lb': 2, 'ub': 3}]
spec['objective'] = {'expr': 'max x'}
result = service.solve_model(spec)
assert result['objective'] == 3, result
results['range_constraint'] = result
os.environ['ESOPT_BACKEND'] = 'highspy'
fallback = service.solve_model(spec)
assert fallback['ok'] and fallback['objective'] == 3, fallback
results['range_highspy'] = fallback
os.environ.pop('ESOPT_BACKEND')
fixed_binary = {'variables': [{'name': 'x', 'domain': 'binary', 'lb': 1}], 'objective': {'expr': 'min x'}}
for mode in ('native', 'highspy'):
    os.environ['ESOPT_BACKEND'] = mode
    result = service.solve_model(fixed_binary)
    assert result['ok'] and result['objective'] == 1, result
    results['fixed_binary_' + mode] = result
os.environ.pop('ESOPT_BACKEND')
spec['constraints'] = [{'expr': 'x >= 11'}]
result = service.solve_model(spec)
assert result['termination_status'] == 8 and not result['ok'] and not result['values'], result
results['infeasible'] = result
for size in (300, 301):
    spec = {'variables': [{'name': f'x{i}', 'lb': 0, 'ub': 1} for i in range(size)], 'objective': {'expr': 'max x0'}}
    result = service.solve_model(spec)
    assert result['ok'] and result['objective'] == 1, result
    assert result['backend'] == ('esopt-native' if size == 300 else 'highspy'), result
    results[f'variables_{size}'] = {key: value for key, value in result.items() if key != 'values'}
os.environ['ESOPT_BACKEND'] = 'native'
try:
    service.solve_model(spec)
except RuntimeError as error:
    assert 'trial limit' in str(error), error
    results['native_301_rejection'] = str(error)
else:
    raise AssertionError('strict native did not reject 301 variables')
os.environ.pop('ESOPT_BACKEND')
for size in (300, 301):
    spec = {'variables': [{'name': 'x', 'lb': 0, 'ub': 1}],
            'constraints': [{'expr': 'x <= 1', 'name': f'c{i}'} for i in range(size)], 'objective': {'expr': 'max x'}}
    result = service.solve_model(spec)
    assert result['ok'] and result['objective'] == 1, result
    assert result['backend'] == ('esopt-native' if size == 300 else 'highspy'), result
    results[f'constraints_{size}'] = {key: value for key, value in result.items() if key != 'values'}
case = service.resolve_case('case24')
reference = solve_dcopf_case(case)
for pslp in (False, True):
    result = service.solve_dcopf('case24', pslp=pslp)
    assert result['backend'] == 'esopt-native' and result['ok'], result
    assert math.isclose(result['objective'], reference['objective'], rel_tol=1e-8), (reference['objective'], result)
    assert abs(result['power_balance_error']) < 1e-7, result
    results[f'dcopf24_pslp_{pslp}'] = {key: value for key, value in result.items() if key not in ('values', 'generator_outputs', 'pg')}
result = service.solve_dcopf('case500', timeout=60)
assert result['backend'] == 'highspy' and result['ok'] and abs(result['power_balance_error']) < 1e-6, result
results['dcopf500'] = {key: value for key, value in result.items() if key not in ('values', 'generator_outputs', 'pg')}
results['capabilities'] = service.capabilities()
print(json.dumps(results, indent=2, ensure_ascii=False))
