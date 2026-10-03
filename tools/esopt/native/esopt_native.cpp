#include <model_highs.h>
#include <nlohmann/json.hpp>
#include <cmath>
#include <iostream>
#include <map>
#include <stdexcept>
using json = nlohmann::json;

static double number(const json& item, const char* key, double fallback) {
    if (!item.contains(key) || item[key].is_null()) return fallback;
    double value = item[key].is_string() ? std::stod(item[key].get<std::string>()) : item[key].get<double>();
    if (std::isnan(value)) throw std::runtime_error(std::string("NaN: ") + key);
    return value;
}

int main() {
    // Upstream may print license diagnostics. The bridge extracts the last JSON line.
    try {
        json spec; std::cin >> spec;
        std::string library = spec.at("highs_lib");
        if (!highs::load_library(library)) throw std::runtime_error("Cannot load HiGHS library: " + library);
        HighsModel model;
        model.set_parameter("output_flag", false);
        model.set_parameter("time_limit", number(spec, "time_limit", 120));
        model.set_parameter("presolve", spec.value("presolve", true) ? "on" : "off");
        bool pslp = spec.value("pslp", false);
        model.set_parameter("pslp", pslp);
        model.set_parameter("pslp_verbose", pslp);
        model.set_parameter("threads", 4);
        std::map<std::string, VariableIndex> variables;
        Vector<VariableIndex> start_variables;
        Vector<double> start_values;
        if (!spec.at("variables").is_array() || spec.at("variables").empty()) throw std::runtime_error("Model requires a nonempty variables array");
        for (const auto& item : spec.at("variables")) {
            std::string name = item.at("name");
            if (variables.count(name)) throw std::runtime_error("Duplicate variable: " + name);
            std::string domain = item.value("domain", item.value("type", std::string("continuous")));
            VariableDomain type;
            if (domain == "binary") type = VariableDomain::Binary;
            else if (domain == "integer") type = VariableDomain::Integer;
            else if (domain == "continuous") type = VariableDomain::Continuous;
            else throw std::runtime_error("Unknown domain: " + domain);
            double lb = number(item, "lb", type == VariableDomain::Binary ? 0 : -INFINITY), ub = number(item, "ub", type == VariableDomain::Binary ? 1 : INFINITY);
            if (type == VariableDomain::Binary) { lb = std::max(lb, 0.0); ub = std::min(ub, 1.0); }
            if (lb > ub) throw std::runtime_error("Lower bound exceeds upper bound: " + name);
            variables.emplace(name, model.add_variable(lb, ub, type, name.c_str()));
            // SDK add_variable(Binary) initializes [0,1] even for a fixed binary.
            // Apply the caller's narrowed bounds explicitly after creation.
            if (type == VariableDomain::Binary) model.set_variable_bounds(variables.at(name), lb, ub);
            if (item.contains("start") && !item["start"].is_null()) {
                start_variables.push_back(variables.at(name));
                start_values.push_back(number(item, "start", 0));
            }
        }
        if (!start_variables.empty()) model.set_primal_start(start_variables, start_values);
        auto affine = [&](const json& item) {
            ScalarAffineFunction expr(number(item, "constant", 0));
            for (const auto& term : item.value("terms", json::array())) {
                std::string name = term.value("var", term.value("name", std::string("")));
                if (!variables.count(name)) throw std::runtime_error("Unknown variable: " + name);
                expr.add_term(variables.at(name), number(term, "coef", number(term, "coefficient", 0)));
            }
            return expr;
        };
        for (const auto& con : spec.value("constraints", json::array())) {
            if (con.contains("quadratic") || con.contains("nonlinear")) throw std::runtime_error("Only linear constraints are supported by this bridge");
            auto expr = affine(con);
            std::string name = con.value("name", std::string(""));
            if (con.contains("lb") || con.contains("ub")) {
                double lb = number(con, "lb", -INFINITY), ub = number(con, "ub", INFINITY);
                if (lb > ub) throw std::runtime_error("Invalid constraint range: " + name);
                model.add_linear_constraint(expr, std::make_tuple(lb, ub), name.c_str());
            } else {
                std::string sense = con.value("sense", std::string("="));
                ConstraintSense s;
                if (sense == "<=" || sense == "le") s = ConstraintSense::LessEqual;
                else if (sense == ">=" || sense == "ge") s = ConstraintSense::GreaterEqual;
                else if (sense == "=" || sense == "==" || sense == "eq") s = ConstraintSense::Equal;
                else throw std::runtime_error("Unknown constraint sense: " + sense);
                model.add_linear_constraint(expr, s, number(con, "rhs", 0), name.c_str());
            }
        }
        auto obj = spec.at("objective");
        if (obj.contains("quadratic") || obj.contains("nonlinear")) throw std::runtime_error("Only linear objectives are supported by this bridge");
        std::string sense = obj.value("sense", std::string("minimize"));
        if (sense != "minimize" && sense != "min" && sense != "maximize" && sense != "max") throw std::runtime_error("Unknown objective sense: " + sense);
        model.set_objective(affine(obj), (sense == "max" || sense == "maximize") ? ObjectiveSense::Maximize : ObjectiveSense::Minimize);
        model.optimize();
        int status = model.get_model_attribute(ModelAttributeInt::TerminationStatus);
        json result = {{"ok", status == 7}, {"success", status == 7}, {"engine", "esopt"}, {"backend", "esopt-native"}, {"solver", "ESOPT / HiGHS"}, {"command", "model"},
            {"termination_status", status}, {"status", status == 7 ? "optimal" : "not_optimal"},
            {"n_variables", variables.size()}, {"n_constraints", spec.value("constraints", json::array()).size()},
            {"pslp_requested", pslp}, {"values", json::object()}};
        // Never report infeasible/unbounded values as a solution.
        if (status == 7) {
            result["objective"] = model.get_obj_value();
            for (const auto& [name, var] : variables) result["values"][name] = model.get_variable_value(var);
        }
        std::cout << result.dump() << std::endl;
        return 0;
    } catch (const std::exception& error) {
        std::cout << json({{"ok", false}, {"error", error.what()}, {"backend", "esopt-native"}}).dump() << std::endl;
        return 1;
    }
}
