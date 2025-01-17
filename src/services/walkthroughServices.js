import axios from 'axios';
import Mustache from 'mustache';
import serviceConfig from './config';
import { watch, process, currentUser, OpenShiftWatchEvents, processV4, poll, KIND_ROUTE } from './openshiftServices';
import { initCustomThread } from './threadServices';
import {
  buildValidProjectNamespaceName,
  findOrCreateOpenshiftResource,
  buildValidNamespaceDisplayName,
  getUsersSharedNamespaceName,
  getUsersSharedNamespaceDisplayName
} from '../common/openshiftHelpers';
import { buildServiceInstanceCompareFn, DEFAULT_SERVICES } from '../common/serviceInstanceHelpers';
import {
  namespaceResource,
  namespaceRequestResource,
  namespaceDef,
  namespaceRequestDef,
  serviceInstanceDef,
  routeDef
} from '../common/openshiftResourceDefinitions';
import { addWalkthroughService, removeWalkthroughService } from '../redux/actions/walkthroughServiceActions';
import {
  initCustomThreadPending,
  initCustomThreadSuccess,
  initCustomThreadFailure
} from '../redux/actions/threadActions';
import { provisionAMQOnline, provisionAMQOnlineV4 } from '../services/amqOnlineServices';
import { provisionFuseOnlineV4, provisionFuseOnline } from '../services/fuseOnlineServices';
import { middlewareTypes } from '../redux/constants';
import { FULFILLED_ACTION } from '../redux/helpers';

const DEFAULT_SERVICE_INSTANCE = {
  kind: 'ServiceInstance',
  apiVersion: 'servicecatalog.k8s.io/v1beta1',
  spec: {
    clusterServicePlanExternalName: 'default'
  }
};

// OpenShift 4 equivalent of #prepareCustomWalkthroughNamespace
const prepareWalkthroughV4 = (dispatch, walkthroughName, attrs = {}) => {
    dispatch(initCustomThreadSuccess({}));
    return Promise.resolve([]);
};

/**
 * Provision a namespace if it does not already exist. Once the namespace is
 * created the ServiceInstances associated with the walkthrough will be
 * provisioned in the namespace.
 *
 * @param {Function} dispatch Redux dispatch.
 * @param {string} walkthoughName The identifier of the walkthrough to provision.
 */
const prepareCustomWalkthroughNamespace = (dispatch, walkthoughName, attrs = {}) => {

    dispatch(initCustomThreadSuccess({}));
    return Promise.resolve([]);

};

// OpenShift 4 equivalent of #provisionManagedServiceSlices that handles a
// single service instead of a list of services.
const provisionOpenShift4Service = (service, namespace, user, dispatch) => {
  if (!service) {
    return Promise.reject(new Error('service must be specified'));
  }
  if (!namespace) {
    return Promise.reject(new Error('namespace must be provided'));
  }
  if (!user) {
    return Promise.reject(new Error('user must be specified'));
  }
  if (!dispatch) {
    return Promise.reject(new Error('dispatch function must be specified'));
  }
  if (service.name === DEFAULT_SERVICES.FUSE) {
    return provisionFuseOnlineV4(dispatch);
  }
  if (service.name === DEFAULT_SERVICES.ENMASSE) {
    return provisionAMQOnlineV4(dispatch, user.username, namespace.name);
  }
  return null;
};

const provisionManagedServiceSlices = (dispatch, svcList, user, namespace) => {
  if (!svcList) {
    return Promise.resolve([]);
  }
  const svcProvisions = svcList.reduce((acc, svc) => {
    if (svc.name === DEFAULT_SERVICES.FUSE) {
      acc.push(
        provisionFuseOnline(user, namespace).then(provision => {
          dispatch({
            type: FULFILLED_ACTION(middlewareTypes.CREATE_WALKTHROUGH),
            payload: provision.event.payload
          });
          return provision.attrs;
        })
      );
    }
    if (svc.name === DEFAULT_SERVICES.ENMASSE) {
      acc.push(
        provisionAMQOnline(dispatch, user, namespace).then(attrs => {
          // Perform a dispatch so the Redux store will pick up on these attrs
          // and they can be used in the UI.
          dispatch({
            type: FULFILLED_ACTION(middlewareTypes.GET_ENMASSE_CREDENTIALS),
            payload: {
              url: attrs['enmasse-broker-url'],
              username: attrs['enmasse-credentials-username'],
              password: attrs['enmasse-credentials-password']
            }
          });
          return attrs;
        })
      );
    }
    return acc;
  }, []);
  // Each of these svcProvisions promises is expected to resolve to an Object
  // containing any additional attributes that should be included in
  // ServiceInstance provisioning.
  return Promise.all(svcProvisions);
};

/**
 * Replace template variables in a ServiceInstance with provided attributes.
 *
 * @param {Object} siTemplate ServiceInstance object.
 * @param {Object} attrs Key-value map of attribute names and values to replace them with.
 */
const parseServiceInstanceTemplate = (siTemplate, attrs) => {
  const rawServiceInstance = Mustache.render(JSON.stringify(siTemplate), attrs);
  return JSON.parse(rawServiceInstance);
};

/**
 * Replace template variables with provided attributes.
 *
 * @param {Object} template Openshift template object.
 * @param {Object} attrs Key-value map of attribute names and values to replace them with.
 */
const parseTemplate = (template, attrs) => {
  const rawTemplate = Mustache.render(JSON.stringify(template), attrs);
  return JSON.parse(rawTemplate);
};

/**
 * Default handle for a watch event on an OpenShift resource. If a resource is
 * of a type that can be watched/parsed by the webapp then this will dispatch
 * appropriate actions for the OpenShift resource so that it can be handled
 * elsewhere.
 *
 * @param {Function} dispatch Redux dispatch.
 * @param {string} walkthroughId The identifier for the walkthrough the resource was created from.
 * @param {Object} event Watch event.
 */
const handleResourceWatchEvent = (dispatch, walkthroughId, event) => {
  if (event.type === OpenShiftWatchEvents.OPENED || event.type === OpenShiftWatchEvents.CLOSED) {
    return;
  }
  if (event.type === OpenShiftWatchEvents.ADDED || event.type === OpenShiftWatchEvents.MODIFIED) {
    dispatch(addWalkthroughService(walkthroughId, event.payload));
    return;
  }
  if (event.type === OpenShiftWatchEvents.DELETED) {
    dispatch(removeWalkthroughService(walkthroughId, event.payload));
  }
};

/**
 * Retrieves the json document for a specified walkthrough (aka thread).
 * @param {} language Specifies the language end point where the json file is stored.  Used to create multiple localized documenation.
 * @param {*} id The ID for the thread.
 */
const getWalkthrough = (language, id) =>
  axios(
    serviceConfig({
      url: `${process.env.REACT_APP_STEELTHREAD_JSON_PATH}${language}/thread-${id}.json`
    })
  );

/**
 * Retrieves a list of walkthroughs from the backend.
 */
const getCustomWalkthroughs = () =>
  axios(
    serviceConfig({
      url: `/customWalkthroughs`
    })
  );

/**
 * Retrieves the GitHub info for the installed walkthrough from the backend.
 */
const getWalkthroughInfo = id =>
  axios(
    serviceConfig({
      url: `/about/walkthrough/${id}`
    })
  );

/**
 * Retrieves the user-defined GitHub repositories from the database.
 */
const getUserWalkthroughs = () =>
  axios(
    serviceConfig({
      url: `/user_walkthroughs`
    })
  );

/**
 * Saves the user-defined GitHub repositories from the UI to the database.
 */
const setUserWalkthroughs = (data = {}, token) =>
  axios(
    serviceConfig(
      {
        method: 'post',
        url: `/user_walkthroughs`,
        data: { data },
        headers: {
          'X-Forwarded-Access-Token': token
        }
      },
      false
    )
  ).then(success => {
    serviceConfig(
      axios({
        method: 'post',
        url: `/sync-walkthroughs`
      })
    );
  });

export {
  getWalkthrough,
  getWalkthroughInfo,
  getCustomWalkthroughs,
  prepareCustomWalkthroughNamespace,
  setUserWalkthroughs,
  getUserWalkthroughs,
  prepareWalkthroughV4
};
