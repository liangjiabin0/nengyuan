#pragma once
#include <vector>
#include <optional>
#include <concepts>
#include "ankerl/unordered_dense.h"

#ifdef _WIN32
    #ifdef MODEL_EXPORTS
        #define MODEL_API __declspec(dllexport)
    #else
        #define MODEL_API __declspec(dllimport)
    #endif
#else
    #define MODEL_API __attribute__((visibility("default")))
#endif

using IndexT = int;
using CoeffT = double;

constexpr CoeffT COEFTHRESHOLD = 1e-12;

template <typename K, typename V>
using Hashmap = ankerl::unordered_dense::map<K, V>;

template <typename K>
using Hashset = ankerl::unordered_dense::set<K>;

template <typename V>
using Vector = std::vector<V>;

struct ExprBuilder;

// Forward declaration for nonlinear expression
struct NLExpr;

enum class VariableDomain
{
	Continuous,
	Integer,
	Binary,
};

class MODEL_API VariableIndex
{
  public:
	VariableIndex() = default;
	VariableIndex(IndexT v) : index(v) {};

  public:
	IndexT index;
};

class MODEL_API ScalarAffineFunction
{
  public:
	ScalarAffineFunction() = default;
	ScalarAffineFunction(CoeffT v);
	ScalarAffineFunction(const VariableIndex &v);
	// v * c
	ScalarAffineFunction(const VariableIndex &v, CoeffT c);
	// v * c1 + c2
	ScalarAffineFunction(const VariableIndex &v, CoeffT c1, CoeffT c2);
	ScalarAffineFunction(const Vector<CoeffT> &, const Vector<IndexT> &);
	ScalarAffineFunction(const Vector<CoeffT> &, const Vector<IndexT> &, const std::optional<CoeffT> &);
	
	ScalarAffineFunction(const ExprBuilder &t);

	size_t size() const;
	void canonicalize(CoeffT threshold = COEFTHRESHOLD);

	const IndexT *get_variables() const;
	const CoeffT *get_coefficients() const;
	std::optional<CoeffT> get_constant() const;

	void reserve(size_t n);
	void add_term(const VariableIndex &v, CoeffT c);
	void add_constant(CoeffT c);

  public:
	Vector<CoeffT> coefficients;
	Vector<IndexT> variables;
	std::optional<CoeffT> constant;
};

struct MODEL_API ScalarQuadraticFunction
{
	Vector<CoeffT> coefficients;
	Vector<IndexT> variable_1s;
	Vector<IndexT> variable_2s;
	std::optional<ScalarAffineFunction> affine_part;

	ScalarQuadraticFunction() = default;
	ScalarQuadraticFunction(const Vector<CoeffT> &, const Vector<IndexT> &, const Vector<IndexT> &);
	ScalarQuadraticFunction(const Vector<CoeffT> &, const Vector<IndexT> &, const Vector<IndexT> &,
	                        const std::optional<ScalarAffineFunction> &);
	ScalarQuadraticFunction(const ExprBuilder &t);

	size_t size() const;
	void canonicalize(CoeffT threshold = COEFTHRESHOLD);

	void reserve_quadratic(size_t n);
	void reserve_affine(size_t n);
	void add_quadratic_term(const VariableIndex &v1, const VariableIndex &v2, CoeffT c);
	void add_affine_term(const VariableIndex &v, CoeffT c);
	void add_constant(CoeffT c);
};





struct VariablePair
{
	IndexT var_1;
	IndexT var_2;

	bool operator==(const VariablePair &x) const;
	bool operator<(const VariablePair &x) const;

	VariablePair() = default;
	VariablePair(IndexT v1, IndexT v2) : var_1(v1), var_2(v2)
	{
	}
};

template <>
struct ankerl::unordered_dense::hash<VariablePair>
{
	using is_avalanching = void;

	[[nodiscard]] auto operator()(VariablePair const &x) const noexcept -> uint64_t
	{
		static_assert(std::has_unique_object_representations_v<VariablePair>);
		return detail::wyhash::hash(&x, sizeof(x));
	}
};

struct MODEL_API ExprBuilder
{
	Hashmap<VariablePair, CoeffT> quadratic_terms;
	Hashmap<IndexT, CoeffT> affine_terms;
	std::optional<CoeffT> constant_term;

	ExprBuilder() = default;
	ExprBuilder(CoeffT c);
	ExprBuilder(const VariableIndex &v);
	ExprBuilder(const ScalarAffineFunction &a);
	ExprBuilder(const ScalarQuadraticFunction &q);

	ExprBuilder &operator+=(CoeffT c);
	ExprBuilder &operator+=(const VariableIndex &v);
	ExprBuilder &operator+=(const ScalarAffineFunction &a);
	ExprBuilder &operator+=(const ScalarQuadraticFunction &q);
	ExprBuilder &operator+=(const ExprBuilder &t);

	ExprBuilder &operator-=(CoeffT c);
	ExprBuilder &operator-=(const VariableIndex &v);
	ExprBuilder &operator-=(const ScalarAffineFunction &a);
	ExprBuilder &operator-=(const ScalarQuadraticFunction &q);
	ExprBuilder &operator-=(const ExprBuilder &t);

	ExprBuilder &operator*=(CoeffT c);
	ExprBuilder &operator*=(const VariableIndex &v);
	ExprBuilder &operator*=(const ScalarAffineFunction &a);
	ExprBuilder &operator*=(const ScalarQuadraticFunction &q);
	ExprBuilder &operator*=(const ExprBuilder &t);

	ExprBuilder &operator/=(CoeffT c);

	bool empty() const;
	int degree() const;

	void reserve_quadratic(size_t n);
	void reserve_affine(size_t n);

	void clear();
	void clean_nearzero_terms(CoeffT threshold = COEFTHRESHOLD);
	void _add_quadratic_term(IndexT i, IndexT j, CoeffT coeff);
	void _set_quadratic_coef(IndexT i, IndexT j, CoeffT coeff);
	void add_quadratic_term(const VariableIndex &i, const VariableIndex &j, CoeffT coeff);
	void set_quadratic_coef(const VariableIndex &i, const VariableIndex &j, CoeffT coeff);
	void _add_affine_term(IndexT i, CoeffT coeff);
	void _set_affine_coef(IndexT i, CoeffT coeff);
	void add_affine_term(const VariableIndex &i, CoeffT coeff);
	void set_affine_coef(const VariableIndex &i, CoeffT coeff);
};

MODEL_API auto operator+(const VariableIndex &a, CoeffT b) -> ScalarAffineFunction;
MODEL_API auto operator+(CoeffT a, const VariableIndex &b) -> ScalarAffineFunction;
MODEL_API auto operator+(const VariableIndex &a, const VariableIndex &b) -> ScalarAffineFunction;
MODEL_API auto operator+(const ScalarAffineFunction &a, CoeffT b) -> ScalarAffineFunction;
MODEL_API auto operator+(CoeffT a, const ScalarAffineFunction &b) -> ScalarAffineFunction;
MODEL_API auto operator+(const ScalarAffineFunction &a, const VariableIndex &b) -> ScalarAffineFunction;
MODEL_API auto operator+(const VariableIndex &a, const ScalarAffineFunction &b) -> ScalarAffineFunction;
MODEL_API auto operator+(const ScalarAffineFunction &a,
               const ScalarAffineFunction &b) -> ScalarAffineFunction;
MODEL_API auto operator+(const ScalarQuadraticFunction &a, CoeffT b) -> ScalarQuadraticFunction;
MODEL_API auto operator+(CoeffT a, const ScalarQuadraticFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator+(const ScalarQuadraticFunction &a, const VariableIndex &b) -> ScalarQuadraticFunction;
MODEL_API auto operator+(const VariableIndex &a, const ScalarQuadraticFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator+(const ScalarQuadraticFunction &a,
               const ScalarAffineFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator+(const ScalarAffineFunction &a,
               const ScalarQuadraticFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator+(const ScalarQuadraticFunction &a,
               const ScalarQuadraticFunction &b) -> ScalarQuadraticFunction;

MODEL_API auto operator-(const VariableIndex &a, CoeffT b) -> ScalarAffineFunction;
MODEL_API auto operator-(CoeffT a, const VariableIndex &b) -> ScalarAffineFunction;
MODEL_API auto operator-(const VariableIndex &a, const VariableIndex &b) -> ScalarAffineFunction;
MODEL_API auto operator-(const ScalarAffineFunction &a, CoeffT b) -> ScalarAffineFunction;
MODEL_API auto operator-(CoeffT a, const ScalarAffineFunction &b) -> ScalarAffineFunction;
MODEL_API auto operator-(const ScalarAffineFunction &a, const VariableIndex &b) -> ScalarAffineFunction;
MODEL_API auto operator-(const VariableIndex &a, const ScalarAffineFunction &b) -> ScalarAffineFunction;
MODEL_API auto operator-(const ScalarAffineFunction &a,
               const ScalarAffineFunction &b) -> ScalarAffineFunction;
MODEL_API auto operator-(const ScalarQuadraticFunction &a, CoeffT b) -> ScalarQuadraticFunction;
MODEL_API auto operator-(CoeffT a, const ScalarQuadraticFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator-(const ScalarQuadraticFunction &a, const VariableIndex &b) -> ScalarQuadraticFunction;
MODEL_API auto operator-(const VariableIndex &a, const ScalarQuadraticFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator-(const ScalarQuadraticFunction &a,
               const ScalarAffineFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator-(const ScalarAffineFunction &a,
               const ScalarQuadraticFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator-(const ScalarQuadraticFunction &a,
               const ScalarQuadraticFunction &b) -> ScalarQuadraticFunction;

MODEL_API auto operator*(const VariableIndex &a, CoeffT b) -> ScalarAffineFunction;
MODEL_API auto operator*(CoeffT a, const VariableIndex &b) -> ScalarAffineFunction;
MODEL_API auto operator*(const VariableIndex &a, const VariableIndex &b) -> ScalarQuadraticFunction;
MODEL_API auto operator*(const ScalarAffineFunction &a, CoeffT b) -> ScalarAffineFunction;
MODEL_API auto operator*(CoeffT a, const ScalarAffineFunction &b) -> ScalarAffineFunction;
MODEL_API auto operator*(const ScalarAffineFunction &a, const VariableIndex &b) -> ScalarQuadraticFunction;
MODEL_API auto operator*(const VariableIndex &a, const ScalarAffineFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator*(const ScalarAffineFunction &a,
               const ScalarAffineFunction &b) -> ScalarQuadraticFunction;
MODEL_API auto operator*(const ScalarQuadraticFunction &a, CoeffT b) -> ScalarQuadraticFunction;
MODEL_API auto operator*(CoeffT a, const ScalarQuadraticFunction &b) -> ScalarQuadraticFunction;

MODEL_API auto operator/(const VariableIndex &a, CoeffT b) -> ScalarAffineFunction;
MODEL_API auto operator/(const ScalarAffineFunction &a, CoeffT b) -> ScalarAffineFunction;
MODEL_API auto operator/(const ScalarQuadraticFunction &a, CoeffT b) -> ScalarQuadraticFunction;

// unary minus operator
MODEL_API auto operator-(const VariableIndex &a) -> ScalarAffineFunction;
MODEL_API auto operator-(const ScalarAffineFunction &a) -> ScalarAffineFunction;
MODEL_API auto operator-(const ScalarQuadraticFunction &a) -> ScalarQuadraticFunction;
MODEL_API auto operator-(const ExprBuilder &a) -> ExprBuilder;

// Operator overloading for	ExprBuilder
// Sadly, they are inefficient than the +=��-=,*=,/= functions but they are important for a
// user-friendly interface
// The functions are like ScalarQuadraticFunction but returns a ExprBuilder
MODEL_API auto operator+(const ExprBuilder &a, CoeffT b) -> ExprBuilder;
MODEL_API auto operator+(CoeffT b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator+(const ExprBuilder &a, const VariableIndex &b) -> ExprBuilder;
MODEL_API auto operator+(const VariableIndex &b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator+(const ExprBuilder &a, const ScalarAffineFunction &b) -> ExprBuilder;
MODEL_API auto operator+(const ScalarAffineFunction &b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator+(const ExprBuilder &a, const ScalarQuadraticFunction &b) -> ExprBuilder;
MODEL_API auto operator+(const ScalarQuadraticFunction &b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator+(const ExprBuilder &a, const ExprBuilder &b) -> ExprBuilder;

MODEL_API auto operator-(const ExprBuilder &a, CoeffT b) -> ExprBuilder;
MODEL_API auto operator-(CoeffT b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator-(const ExprBuilder &a, const VariableIndex &b) -> ExprBuilder;
MODEL_API auto operator-(const VariableIndex &b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator-(const ExprBuilder &a, const ScalarAffineFunction &b) -> ExprBuilder;
MODEL_API auto operator-(const ScalarAffineFunction &b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator-(const ExprBuilder &a, const ScalarQuadraticFunction &b) -> ExprBuilder;
MODEL_API auto operator-(const ScalarQuadraticFunction &b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator-(const ExprBuilder &a, const ExprBuilder &b) -> ExprBuilder;

MODEL_API auto operator*(const ExprBuilder &a, CoeffT b) -> ExprBuilder;
MODEL_API auto operator*(CoeffT b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator*(const ExprBuilder &a, const VariableIndex &b) -> ExprBuilder;
MODEL_API auto operator*(const VariableIndex &b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator*(const ExprBuilder &a, const ScalarAffineFunction &b) -> ExprBuilder;
MODEL_API auto operator*(const ScalarAffineFunction &b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator*(const ExprBuilder &a, const ScalarQuadraticFunction &b) -> ExprBuilder;
MODEL_API auto operator*(const ScalarQuadraticFunction &b, const ExprBuilder &a) -> ExprBuilder;
MODEL_API auto operator*(const ExprBuilder &a, const ExprBuilder &b) -> ExprBuilder;

MODEL_API auto operator/(const ExprBuilder &a, CoeffT b) -> ExprBuilder;

#if 1
// Nonlinear expression class for automatic differentiation
struct MODEL_API NLTerm
{
	// Term types for nonlinear expressions
	enum class TermType
	{
		Variable,       // x_i
		Constant,       // constant value
		Sin,            // sin(x)
		Cos,            // cos(x)
		Exp,            // exp(x)
		Log,            // log(x)
		Pow,            // x^p (power)
		Sqrt,           // sqrt(x)
		Mul,            // x * y
		Div,            // x / y
		Add,            // x + y
		Sub,            // x - y
		Neg,            // -x
	};

	TermType type;
	IndexT var_index;           // for Variable type
	CoeffT constant;            // for Constant type
	CoeffT power;               // for Pow type
	IndexT child1_index;        // index of first child in expression tree
	IndexT child2_index;        // index of second child in expression tree (for binary ops)

	NLTerm() : type(TermType::Constant), var_index(-1), constant(0.0), power(1.0),
	           child1_index(-1), child2_index(-1) {}
	NLTerm(TermType t) : type(t), var_index(-1), constant(0.0), power(1.0),
	                     child1_index(-1), child2_index(-1) {}
};

// Nonlinear Expression with automatic differentiation support
class MODEL_API NLExpr
{
public:
	NLExpr() = default;
	NLExpr(CoeffT c);
	NLExpr(const VariableIndex &v);
	NLExpr(const ScalarAffineFunction &f);

	// Build from expression tree nodes
	NLExpr(const NLTerm &term);

	// Unary operations
	static NLExpr sin(const NLExpr &e);
	static NLExpr cos(const NLExpr &e);
	static NLExpr exp(const NLExpr &e);
	static NLExpr log(const NLExpr &e);
	static NLExpr sqrt(const NLExpr &e);
	static NLExpr pow(const NLExpr &base, CoeffT exponent);
	static NLExpr pow(const NLExpr &base, const NLExpr &exponent);

	// Operator overloading
	NLExpr &operator+=(CoeffT c);
	NLExpr &operator+=(const NLExpr &e);
	NLExpr &operator+=(const VariableIndex &v);
	NLExpr &operator+=(const ScalarAffineFunction &f);

	NLExpr &operator-=(CoeffT c);
	NLExpr &operator-=(const NLExpr &e);
	NLExpr &operator-=(const VariableIndex &v);
	NLExpr &operator-=(const ScalarAffineFunction &f);

	NLExpr &operator*=(CoeffT c);
	NLExpr &operator*=(const NLExpr &e);
	NLExpr &operator*=(const VariableIndex &v);
	NLExpr &operator*=(const ScalarAffineFunction &f);

	NLExpr &operator/=(CoeffT c);
	NLExpr &operator/=(const NLExpr &e);
	NLExpr &operator/=(const VariableIndex &v);
	NLExpr &operator/=(const ScalarAffineFunction &f);

	// Evaluate expression at given point
	CoeffT evaluate(const Vector<CoeffT> &x) const;

	// Compute gradient at given point
	Vector<CoeffT> gradient(size_t n_vars, const Vector<CoeffT> &x) const;

	// Get sparsity pattern of gradient (indices of non-zero elements)
	Vector<IndexT> gradient_sparsity(size_t n_vars) const;

	// Get number of variables in expression
	size_t num_variables() const;

	// Get all variable indices used in expression
	Vector<IndexT> get_variables() const;

	// Build expression tree and get root index
	IndexT get_root_index() const { return m_root_index; }

private:
	// Expression tree storage
	Vector<NLTerm> m_terms;
	IndexT m_root_index;

	// Helper functions for building expression tree
	IndexT add_term(const NLTerm &term);
	IndexT build_affine_tree(const ScalarAffineFunction &f);

	// Helper functions for evaluation and gradient
	CoeffT evaluate_impl(IndexT idx, const Vector<CoeffT> &x) const;
	void compute_gradient(IndexT idx, const Vector<CoeffT> &x, Vector<CoeffT> &grad, CoeffT adjoint) const;
	void collect_variables(IndexT idx, Hashset<IndexT> &var_set) const;

	// Friend declarations for operator overloads
	friend MODEL_API auto operator+(const NLExpr &a, CoeffT b) -> NLExpr;
	friend MODEL_API auto operator+(CoeffT a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator+(const NLExpr &a, const VariableIndex &b) -> NLExpr;
	friend MODEL_API auto operator+(const VariableIndex &a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator+(const NLExpr &a, const ScalarAffineFunction &b) -> NLExpr;
	friend MODEL_API auto operator+(const ScalarAffineFunction &a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator+(const NLExpr &a, const NLExpr &b) -> NLExpr;

	friend MODEL_API auto operator-(const NLExpr &a, CoeffT b) -> NLExpr;
	friend MODEL_API auto operator-(CoeffT a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator-(const NLExpr &a, const VariableIndex &b) -> NLExpr;
	friend MODEL_API auto operator-(const VariableIndex &a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator-(const NLExpr &a, const ScalarAffineFunction &b) -> NLExpr;
	friend MODEL_API auto operator-(const ScalarAffineFunction &a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator-(const NLExpr &a, const NLExpr &b) -> NLExpr;

	friend MODEL_API auto operator*(const NLExpr &a, CoeffT b) -> NLExpr;
	friend MODEL_API auto operator*(CoeffT a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator*(const NLExpr &a, const VariableIndex &b) -> NLExpr;
	friend MODEL_API auto operator*(const VariableIndex &a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator*(const NLExpr &a, const ScalarAffineFunction &b) -> NLExpr;
	friend MODEL_API auto operator*(const ScalarAffineFunction &a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator*(const NLExpr &a, const NLExpr &b) -> NLExpr;

	friend MODEL_API auto operator/(const NLExpr &a, CoeffT b) -> NLExpr;
	friend MODEL_API auto operator/(CoeffT a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator/(const NLExpr &a, const VariableIndex &b) -> NLExpr;
	friend MODEL_API auto operator/(const VariableIndex &a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator/(const NLExpr &a, const ScalarAffineFunction &b) -> NLExpr;
	friend MODEL_API auto operator/(const ScalarAffineFunction &a, const NLExpr &b) -> NLExpr;
	friend MODEL_API auto operator/(const NLExpr &a, const NLExpr &b) -> NLExpr;

	friend MODEL_API auto operator-(const NLExpr &a) -> NLExpr;
};

// NLExpr operator overloads
MODEL_API auto operator+(const NLExpr &a, CoeffT b) -> NLExpr;
MODEL_API auto operator+(CoeffT a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator+(const NLExpr &a, const VariableIndex &b) -> NLExpr;
MODEL_API auto operator+(const VariableIndex &a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator+(const NLExpr &a, const ScalarAffineFunction &b) -> NLExpr;
MODEL_API auto operator+(const ScalarAffineFunction &a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator+(const NLExpr &a, const NLExpr &b) -> NLExpr;

MODEL_API auto operator-(const NLExpr &a, CoeffT b) -> NLExpr;
MODEL_API auto operator-(CoeffT a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator-(const NLExpr &a, const VariableIndex &b) -> NLExpr;
MODEL_API auto operator-(const VariableIndex &a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator-(const NLExpr &a, const ScalarAffineFunction &b) -> NLExpr;
MODEL_API auto operator-(const ScalarAffineFunction &a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator-(const NLExpr &a, const NLExpr &b) -> NLExpr;

MODEL_API auto operator*(const NLExpr &a, CoeffT b) -> NLExpr;
MODEL_API auto operator*(CoeffT a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator*(const NLExpr &a, const VariableIndex &b) -> NLExpr;
MODEL_API auto operator*(const VariableIndex &a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator*(const NLExpr &a, const ScalarAffineFunction &b) -> NLExpr;
MODEL_API auto operator*(const ScalarAffineFunction &a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator*(const NLExpr &a, const NLExpr &b) -> NLExpr;

MODEL_API auto operator/(const NLExpr &a, CoeffT b) -> NLExpr;
MODEL_API auto operator/(CoeffT a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator/(const NLExpr &a, const VariableIndex &b) -> NLExpr;
MODEL_API auto operator/(const VariableIndex &a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator/(const NLExpr &a, const ScalarAffineFunction &b) -> NLExpr;
MODEL_API auto operator/(const ScalarAffineFunction &a, const NLExpr &b) -> NLExpr;
MODEL_API auto operator/(const NLExpr &a, const NLExpr &b) -> NLExpr;

MODEL_API auto operator-(const NLExpr &a) -> NLExpr;

// Convenience functions
MODEL_API NLExpr sin(const NLExpr &e);
MODEL_API NLExpr cos(const NLExpr &e);
MODEL_API NLExpr exp(const NLExpr &e);
MODEL_API NLExpr log(const NLExpr &e);
MODEL_API NLExpr sqrt(const NLExpr &e);
MODEL_API NLExpr pow(const NLExpr &base, CoeffT exponent);
#endif

#define VarIndexModel typename

template <std::integral NZT, std::integral IDXT, std::floating_point VALT>
struct AffineFunctionPtrForm
{
	NZT numnz;
	IDXT* index;
	VALT* value;
	std::vector<IDXT> index_storage;
	std::vector<VALT> value_storage;

	template <VarIndexModel T>
	void make(T* model, const ScalarAffineFunction& function)
	{
		auto f_numnz = function.size();
		numnz = f_numnz;
		index_storage.resize(numnz);
		for (int i = 0; i < numnz; ++i)
		{
			index_storage[i] = model->_variable_index(function.variables[i]);
		}
		index = index_storage.data();
		if constexpr (std::is_same_v<VALT, CoeffT>)
		{
			value = (VALT*)function.coefficients.data();
		}
		else
		{
			value_storage.resize(numnz);
			for (int i = 0; i < numnz; ++i)
			{
				value_storage[i] = function.coefficients[i];
			}
		}
	}
};