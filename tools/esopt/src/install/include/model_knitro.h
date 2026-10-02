#pragma once
#include "knitro.h"
#include "model_base.h"
#include "dylib.h"
#include "variable_expression.h"
#include "constraint.h"

#include <map>
#include <vector>

#define APILIST \
    B(KN_new); \
    B(KN_free); \
    B(KN_set_var_name); \
    B(KN_add_con); \
    B(KN_add_var); \
    B(KN_set_con_lobnd); \
    B(KN_set_con_upbnd); \
    B(KN_set_con_eqbnd); \
    B(KN_add_obj_constant); \
    B(KN_add_obj_linear_struct); \
    B(KN_add_con_linear_struct_one); \
    B(KN_add_con_quadratic_struct_one); \
    B(KN_add_con_constant);\
    B(KN_set_con_name);     \
    B(KN_get_obj_value); \
    B(KN_get_var_primal_value); \
    B(KN_solve); \
    B(KN_set_obj_goal); \
    B(KN_set_var_upbnd); \
    B(KN_set_var_lobnd); \
    B(KN_set_var_type); \
    B(KN_load_param_file); \
    B(KN_add_eval_callback); \
    B(KN_set_cb_grad); \
    B(KN_set_cb_hess); \
    B(KN_set_cb_gradopt); \
    B(KN_add_eval_callback_one); \
    B(KN_set_cb_user_params); \
    B(KN_set_int_param); \
    B(KN_set_double_param); \
    B(KN_set_char_param);

namespace knitro
{
#define B DYLIB_EXTERN_DECLARE
APILIST
#undef B

bool is_library_loaded();

bool MODEL_API load_library(const std::string &path);
} //namespace knitro

class MODEL_API KnitroModel : public ModelBase
{
public:
    KnitroModel();
    ~KnitroModel();

    void init();
    void close();

    //add variables
    VariableIndex add_variable(double lb, double ub, VariableDomain domain = VariableDomain::Continuous,
    const char* name = nullptr) override;

    //add constraints
    ConstraintIndex add_linear_constraint(const ScalarAffineFunction& f, ConstraintSense sense, double rhs, const char * name) override;
    ConstraintIndex add_quadratic_constraint(const ScalarQuadraticFunction &f,
                                                     ConstraintSense sense, double rhs,
                                                     const char *name);
    ConstraintIndex add_quadratic_constraint(const ScalarQuadraticFunction &f,
                                                     const std::tuple<double, double> &interval,
                                                     const char *name);

    // Add nonlinear constraint with automatic differentiation
    NLConstraintIndex add_nl_constraint(const NLExpr &expr, ConstraintSense sense, double rhs,
                                        const char *name = nullptr);
    NLConstraintIndex add_nl_constraint(const NLExpr &expr, const std::tuple<double, double> &interval,
                                        const char *name = nullptr);
    //set objection
    void set_objective(const ScalarAffineFunction& f, ObjectiveSense sense) override;

    //solve optimized model
    void optimize() override;

    //set variable bound
    void set_variable_bounds(const VariableIndex &variable, double lb, double ub) override;

    //get variable value
    double get_variable_value(const VariableIndex &variable) override;

    //model settings
    bool supports_model_attribute(ModelAttributeDouble attribute, bool changeable) override;
    bool supports_model_attribute(ModelAttributeInt attribute, bool changeable) override;
    bool supports_model_attribute(ModelAttributeString attribute, bool changeable) override;

    double get_model_attribute(ModelAttributeDouble attribute) override;
    int get_model_attribute(ModelAttributeInt attribute) override;
    std::string get_model_attribute(ModelAttributeString attribute) override;

    void set_model_attribute(ModelAttributeDouble attribute, double value) override;
	void set_model_attribute(ModelAttributeInt attribute, int value) override;
	void set_model_attribute(ModelAttributeString attribute, const char *value) override;

    //variable settings
	bool supports_variable_attribute(VariableAttributeDouble attribute, bool changeable) override;
	bool supports_variable_attribute(VariableAttributeInt attribute, bool changeable) override;
	bool supports_variable_attribute(VariableAttributeString attribute, bool changeable) override;
	
    double get_variable_attribute(const VariableIndex& variable, VariableAttributeDouble attribute) override;
	int get_variable_attribute(const VariableIndex& variable, VariableAttributeInt attribute) override;
	std::string get_variable_attribute(const VariableIndex& variable, VariableAttributeString attribute) override;
	
    void set_variable_attribute(const VariableIndex& variable, VariableAttributeDouble attribute, double value) override;
	void set_variable_attribute(const VariableIndex& variable, VariableAttributeInt attribute, int value) override;
	void set_variable_attribute(const VariableIndex& variable, VariableAttributeString attribute, const char *value) override;
	void set_variable_attribute(const VariableIndex &variable, VariableAttributeString attribute, VariableDomain domain);
	
    //constraint settings
	bool supports_constraint_attribute(ConstraintAttributeDouble attribute, bool changeable) override;
	bool supports_constraint_attribute(ConstraintAttributeInt attribute, bool changeable) override;
	bool supports_constraint_attribute(ConstraintAttributeString attribute, bool changeable) override;

    double get_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeDouble attribute) override;
	int get_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeInt attribute) override;
	std::string get_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeString attribute) override;

    void set_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeDouble attribute, double value) override;
	void set_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeInt attribute, int value) override;
	void set_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeString attribute, const char *value) override;


    //solver setting
	void set_parameter(const char* name, double value) override;
	void set_parameter(const char* name, int value) override;
	void set_parameter(const char* name, const char* value) override;
    void set_parameter();

    int set_option_int_by_code(const int &code, int value);
    int set_option_double_by_code(const int &code, double value);
    int set_option_string_by_code(const int &code, const std::string &value);

    ObjectiveSense get_obj_sense();
    void set_obj_sense(ObjectiveSense sense);
    double get_obj_value();

    int _variable_index(const VariableIndex &variable);
    int _constraint_index(const ConstraintIndex &constraint);

private:
    //set no quadraitc term obj
    void _set_affine_objective(const ScalarAffineFunction& f, ObjectiveSense sense, bool clear_quadratic);

private:    
    class Impl;
    std::unique_ptr<Impl> pImpl;

    // knitro instance ptr
    KN_context * kc = 0;

    std::vector<double> m_quadratic_con_lb, m_quadratic_con_ub;;
    
public:
    // counter of variable
    size_t m_n_variables = 0;
    // counter of linear constriants
    size_t m_n_liner_cons = 0;
    size_t m_n_quadratic_cons = 0;
    size_t m_n_nl_cons = 0;

    // Nonlinear constraint storage
    struct NLConstraintInfo
    {
        NLExpr expr;                    // Expression tree
        Vector<IndexT> var_indices;     // Variable indices in gradient sparsity
        Vector<IndexT> jac_index_vars;  // Jacobian variable indices
        Vector<IndexT> jac_index_cons;  // Jacobian constraint indices
        CB_context_ptr cb = nullptr;    // Callback context
    };

    std::vector<NLConstraintInfo> m_nl_constraints;

#if 1
#else
    // knitro variable manager
    int KNVarMgr[MAX_KN_VAR_NUM];

    // Knitro contraint manager
    int KNConMgr[MAX_KN_CON_NUM];
#endif
};