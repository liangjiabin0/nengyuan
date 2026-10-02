#pragma once

#include <cstdint>
#include <vector>
#include <type_traits>
#include <cmath>

#include "ankerl/unordered_dense.h"
#include "variable_expression.h"
#include "nlgraph_ctx.hpp"
#include "constraint.h"

using NodeId = uint32_t;
using EntityId = int;

using VariableNode = EntityId;
using ConstantNode = double;
using ParameterNode = EntityId;

enum class ArrayType
{
	Constant,
	Variable,
	Parameter,
	Unary,
	Binary,
	Ternary,
	Nary
};

enum class UnaryOperator
{
	Neg,
	Sin,
	Cos,
	Tan,
	Asin,
	Acos,
	Atan,
	Abs,
	Sqrt,
	Exp,
	Log,
	Log10
};

enum class BinaryOperator
{
	Sub,
	Div,
	Pow,

	// compare
	LessThan,
	LessEqual,
	Equal,
	NotEqual,
	GreaterEqual,
	GreaterThan,

	// Compatibility issue where some solvers only accepts two-arg multiplication
	Add2,
	Mul2
};

bool is_binary_compare_op(BinaryOperator op);

// Map ConstraintSense to BinaryOperator for comparison expressions
inline BinaryOperator constraint_sense_to_binary_op(ConstraintSense sense)
{
	switch (sense)
	{
	case ConstraintSense::LessEqual:
		return BinaryOperator::LessEqual;
	case ConstraintSense::GreaterEqual:
		return BinaryOperator::GreaterEqual;
	case ConstraintSense::Equal:
		return BinaryOperator::Equal;
	default:
		throw std::runtime_error("ConstraintSense cannot be converted to BinaryOperator");
	}
}

enum class TernaryOperator
{
	IfThenElse,
};

enum class NaryOperator
{
	Add,
	Mul,
};

std::string unary_operator_to_string(UnaryOperator op);
std::string binary_operator_to_string(BinaryOperator op);
std::string ternary_operator_to_string(TernaryOperator op);
std::string nary_operator_to_string(NaryOperator op);

struct ExpressionHandle
{
	ArrayType array;
	NodeId id;

	bool operator==(const ExpressionHandle &x) const;

	ExpressionHandle() = default;
	ExpressionHandle(ArrayType array, NodeId id) : array(array), id(id)
	{
	}

	std::string to_string() const;
};

template <>
struct ankerl::unordered_dense::hash<ExpressionHandle>
{
	using is_avalanching = void;

	[[nodiscard]] auto operator()(ExpressionHandle const &x) const noexcept -> uint64_t
	{
		static_assert(std::has_unique_object_representations_v<ExpressionHandle>);
		return detail::wyhash::hash(&x, sizeof(x));
	}
};

struct UnaryNode
{
	UnaryOperator op;
	ExpressionHandle operand;

	UnaryNode(UnaryOperator op, ExpressionHandle operand) : op(op), operand(operand)
	{
	}
};

struct BinaryNode
{
	BinaryOperator op;
	ExpressionHandle left;
	ExpressionHandle right;

	BinaryNode(BinaryOperator op, ExpressionHandle left, ExpressionHandle right)
	    : op(op), left(left), right(right)
	{
	}
};

struct TernaryNode
{
	TernaryOperator op;
	ExpressionHandle left;
	ExpressionHandle middle;
	ExpressionHandle right;

	TernaryNode(TernaryOperator op, ExpressionHandle left, ExpressionHandle middle,
	            ExpressionHandle right)
	    : op(op), left(left), middle(middle), right(right)
	{
	}
};

struct NaryNode
{
	NaryOperator op;
	std::vector<ExpressionHandle> operands;

	NaryNode(NaryOperator op, const std::vector<ExpressionHandle> &operands)
	    : op(op), operands(operands)
	{
	}
};

struct MODEL_API ExpressionGraph
{
	Hashmap<EntityId, size_t> m_variable_index_map;
	std::vector<VariableNode> m_variables;
	std::vector<ConstantNode> m_constants;
	std::vector<ParameterNode> m_parameters;
	std::vector<UnaryNode> m_unaries;
	std::vector<BinaryNode> m_binaries;
	std::vector<TernaryNode> m_ternaries;
	std::vector<NaryNode> m_naries;

	std::vector<ExpressionHandle> m_constraint_outputs;
	std::vector<ExpressionHandle> m_objective_outputs;

	ExpressionGraph() = default;

	std::string to_string() const;

	size_t n_variables() const;
	size_t n_constants() const;
	size_t n_parameters() const;

	ExpressionHandle add_variable(EntityId id);

	ExpressionHandle add_constant(double value);

	ExpressionHandle add_parameter(EntityId id);

	ExpressionHandle add_unary(UnaryOperator op, ExpressionHandle operand);

	ExpressionHandle add_binary(BinaryOperator op, ExpressionHandle left, ExpressionHandle right);

	ExpressionHandle add_ternary(TernaryOperator op, ExpressionHandle left, ExpressionHandle middle,
	                             ExpressionHandle right);

	ExpressionHandle add_nary(NaryOperator op, const std::vector<ExpressionHandle> &operands);
	ExpressionHandle add_repeat_nary(NaryOperator op, ExpressionHandle operand, int N);

	void append_nary(const ExpressionHandle &expression, const ExpressionHandle &operand);

	NaryOperator get_nary_operator(const ExpressionHandle &expression) const;

	void add_constraint_output(const ExpressionHandle &expression);
	void add_objective_output(const ExpressionHandle &expression);
	bool has_constraint_output() const;
	bool has_objective_output() const;

	// Merge VariableIndex/ScalarAffineFunction/ScalarQuadraticFunction/ExprBuilder into
	// ExpressionGraph
	ExpressionHandle merge_variableindex(const VariableIndex &v);
	ExpressionHandle merge_scalaraffinefunction(const ScalarAffineFunction &f);
	ExpressionHandle merge_scalarquadraticfunction(const ScalarQuadraticFunction &f);
	ExpressionHandle merge_exprbuilder(const ExprBuilder &expr);

	// recognize compare expression
	bool is_compare_expression(const ExpressionHandle &expr) const;

	// tag the structure
	uint64_t main_structure_hash() const;
	uint64_t constraint_structure_hash(uint64_t hash) const;
	uint64_t objective_structure_hash(uint64_t hash) const;
};

MODEL_API void unpack_comparison_expression(ExpressionGraph &graph, const ExpressionHandle &expr,
                                  ExpressionHandle &real_expr, double &lb, double &ub);

// Convert various expression types to ExpressionHandle
template<typename T>
ExpressionHandle convert_to_expressionhandle(ExpressionGraph &graph, const T &expr);

// Specialization for ExpressionHandle (identity)
template<>
inline ExpressionHandle convert_to_expressionhandle(ExpressionGraph &graph, const ExpressionHandle &expr)
{
	(void)graph;
	return expr;
}

// Specialization for numeric types
template<>
inline ExpressionHandle convert_to_expressionhandle(ExpressionGraph &graph, const double &expr)
{
	return graph.add_constant(expr);
}

template<>
inline ExpressionHandle convert_to_expressionhandle(ExpressionGraph &graph, const int &expr)
{
	return graph.add_constant(static_cast<double>(expr));
}

// Forward declarations for the specializations
class VariableIndex;
class ScalarAffineFunction;
class ScalarQuadraticFunction;
struct ExprBuilder;
class NLExpr;

// Specializations for the expression types
template<>
MODEL_API ExpressionHandle convert_to_expressionhandle(ExpressionGraph &graph, const VariableIndex &expr);

template<>
MODEL_API ExpressionHandle convert_to_expressionhandle(ExpressionGraph &graph, const ScalarAffineFunction &expr);

template<>
MODEL_API ExpressionHandle convert_to_expressionhandle(ExpressionGraph &graph, const ScalarQuadraticFunction &expr);

template<>
MODEL_API ExpressionHandle convert_to_expressionhandle(ExpressionGraph &graph, const ExprBuilder &expr);

// Boring old implementation - commented out
// template<>
// ExpressionHandle convert_to_expressionhandle(ExpressionGraph &graph, const NLExpr &expr);

// Convert various expression types to ExpressionHandle using the current graph context
// Forward declaration only - implementation after convert_to_expressionhandle specializations
template<typename T>
ExpressionHandle to_nlexpr(const T &expr);

// Convert various expression types to ExpressionHandle using the current graph context
template<typename T>
ExpressionHandle to_nlexpr(const T &expr)
{
	if constexpr (std::is_same_v<T, ExpressionHandle>)
	{
		return expr;
	}
	else
	{
		auto graph = ExpressionGraphContext::current_graph();
		return convert_to_expressionhandle(*graph, expr);
	}
}

// Helper template for unary mathematical functions
template<typename MathFunc, typename T>
auto unary_mathematical_function(MathFunc math_func, UnaryOperator op, const T &expr)
{
	if constexpr (std::is_arithmetic_v<T>)
	{
		return math_func(expr);
	}
	else
	{
		auto graph = ExpressionGraphContext::current_graph();
		ExpressionHandle handle = convert_to_expressionhandle(*graph, expr);
		return graph->add_unary(op, handle);
	}
}

// Overload for ExpressionHandle specifically
inline ExpressionHandle unary_mathematical_function(double (*)(double), UnaryOperator op, const ExpressionHandle &expr)
{
	auto graph = ExpressionGraphContext::current_graph();
	return graph->add_unary(op, expr);
}

// Unary mathematical functions
template<typename T>
auto sin(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::sin), UnaryOperator::Sin, expr);
}

template<typename T>
auto cos(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::cos), UnaryOperator::Cos, expr);
}

template<typename T>
auto tan(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::tan), UnaryOperator::Tan, expr);
}

template<typename T>
auto asin(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::asin), UnaryOperator::Asin, expr);
}

template<typename T>
auto acos(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::acos), UnaryOperator::Acos, expr);
}

template<typename T>
auto atan(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::atan), UnaryOperator::Atan, expr);
}

template<typename T>
auto abs(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::fabs), UnaryOperator::Abs, expr);
}

template<typename T>
auto sqrt(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::sqrt), UnaryOperator::Sqrt, expr);
}

template<typename T>
auto exp(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::exp), UnaryOperator::Exp, expr);
}

template<typename T>
auto log(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::log), UnaryOperator::Log, expr);
}

template<typename T>
auto log10(const T &expr)
{
	return unary_mathematical_function(static_cast<double(*)(double)>(std::log10), UnaryOperator::Log10, expr);
}

// Binary mathematical function for pow
template<typename T1, typename T2>
auto pow(const T1 &base, const T2 &exponent)
{
	if constexpr (std::is_arithmetic_v<T1> && std::is_arithmetic_v<T2>)
	{
		return std::pow(base, exponent);
	}
	else
	{
		auto graph = ExpressionGraphContext::current_graph();
		ExpressionHandle base_handle = convert_to_expressionhandle(*graph, base);
		ExpressionHandle exp_handle = convert_to_expressionhandle(*graph, exponent);
		return graph->add_binary(BinaryOperator::Pow, base_handle, exp_handle);
	}
}

// IfThenElse ternary function
template<typename T1, typename T2, typename T3>
auto ifelse(const T1 &condition, const T2 &true_expr, const T3 &false_expr)
{
	if constexpr (std::is_same_v<T1, bool>)
	{
		if (condition)
		{
			return true_expr;
		}
		else
		{
			return false_expr;
		}
	}
	else
	{
		auto graph = ExpressionGraphContext::current_graph();
		ExpressionHandle cond_handle = convert_to_expressionhandle(*graph, condition);
		ExpressionHandle true_handle = convert_to_expressionhandle(*graph, true_expr);
		ExpressionHandle false_handle = convert_to_expressionhandle(*graph, false_expr);
		return graph->add_ternary(TernaryOperator::IfThenElse, cond_handle, true_handle, false_handle);
	}
}
