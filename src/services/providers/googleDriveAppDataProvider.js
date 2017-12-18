import store from '../../store';
import googleHelper from './helpers/googleHelper';
import providerRegistry from './providerRegistry';

export default providerRegistry.register({
  id: 'googleDriveAppData',
  getToken() {
    return store.getters['data/loginToken'];
  },
  getChanges(token) {
    return googleHelper.getChanges(token)
      .then((result) => {
        const changes = result.changes.filter((change) => {
          if (change.file) {
            try {
              change.item = JSON.parse(change.file.name);
            } catch (e) {
              return false;
            }
            // Build sync data
            change.syncData = {
              id: change.fileId,
              itemId: change.item.id,
              type: change.item.type,
              hash: change.item.hash,
            };
            change.file = undefined;
          }
          return true;
        });
        changes.nextPageToken = result.nextPageToken;
        return changes;
      });
  },
  setAppliedChanges(token, changes) {
    const lastToken = store.getters['data/googleTokens'][token.sub];
    if (changes.nextPageToken !== lastToken.nextPageToken) {
      store.dispatch('data/setGoogleToken', {
        ...lastToken,
        nextPageToken: changes.nextPageToken,
      });
    }
  },
  saveItem(token, item, syncData, ifNotTooLate) {
    return googleHelper.uploadAppDataFile(
        token,
        JSON.stringify(item), ['appDataFolder'],
        null,
        syncData && syncData.id,
        ifNotTooLate,
      )
      .then(file => ({
        // Build sync data
        id: file.id,
        itemId: item.id,
        type: item.type,
        hash: item.hash,
      }));
  },
  removeItem(token, syncData, ifNotTooLate) {
    return googleHelper.removeAppDataFile(token, syncData.id, ifNotTooLate)
      .then(() => syncData);
  },
  downloadContent(token, syncLocation) {
    return this.downloadData(token, `${syncLocation.fileId}/content`);
  },
  downloadData(token, dataId) {
    const syncData = store.getters['data/syncDataByItemId'][dataId];
    if (!syncData) {
      return Promise.resolve();
    }
    return googleHelper.downloadAppDataFile(token, syncData.id)
      .then((content) => {
        const item = JSON.parse(content);
        if (item.hash !== syncData.hash) {
          store.dispatch('data/patchSyncData', {
            [syncData.id]: {
              ...syncData,
              hash: item.hash,
            },
          });
        }
        return item;
      });
  },
  uploadContent(token, content, syncLocation, ifNotTooLate) {
    return this.uploadData(token, content, `${syncLocation.fileId}/content`, ifNotTooLate)
      .then(() => syncLocation);
  },
  uploadData(token, item, dataId, ifNotTooLate) {
    const syncData = store.getters['data/syncDataByItemId'][dataId];
    if (syncData && syncData.hash === item.hash) {
      return Promise.resolve();
    }
    return googleHelper.uploadAppDataFile(
        token,
        JSON.stringify({
          id: item.id,
          type: item.type,
          hash: item.hash,
        }),
        ['appDataFolder'],
        JSON.stringify(item),
        syncData && syncData.id,
        ifNotTooLate,
      )
      .then(file => store.dispatch('data/patchSyncData', {
        [file.id]: {
          // Build sync data
          id: file.id,
          itemId: item.id,
          type: item.type,
          hash: item.hash,
        },
      }));
  },
  listRevisions(token, fileId) {
    const syncData = store.getters['data/syncDataByItemId'][`${fileId}/content`];
    return googleHelper.getFileRevisions(token, syncData.id)
      .then(revisions => revisions.map(revision => ({
        id: revision.id,
        sub: revision.lastModifyingUser && revision.lastModifyingUser.permissionId,
        created: new Date(revision.modifiedTime).getTime(),
      })));
  },
  getRevisionContent(token, fileId, revisionId) {
    const syncData = store.getters['data/syncDataByItemId'][`${fileId}/content`];
    return googleHelper.downloadFileRevision(token, syncData.id, revisionId)
      .then(content => JSON.parse(content));
  },
});
