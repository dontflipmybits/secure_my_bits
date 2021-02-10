/*
**** This is a JavaScript SDK Wrapper ****
    This wrapper is used for easy interaction with the SDK to handle saved searches as well as the KV Store.
    Functionality includes:

        /// Getters used to return an object ///
        - saved_search : Returns the current saved search object
        - ss_props : Returns all saved search properties from savedsearches.conf
        - ss_perms : Returns permissions from local.meta

        /// High level Abstract Methods used in dashboard ///
        - changePlay() : Changes current saved search object to new specified play
        - changeState() : Changes play to enabled/disabled
        - createSearch() : Creates a play, then updates the KV Store, and reloads the saved search object
        - kv_data() : Allows for kv_props to be available for use, which contains the KV store properties
        - updateSearch() : Allows for renaming, editing, and changing permissions of a search, also updates the KV Store then reloads the saved search object accordingly

        /// Lower level mMethods to be called by the higher level functions ///
        - _changePerms() : Used to change owner, sharing, read, and write permissions
        - _createSS() : Creates a saved search
        - _deleteKVstore : Deletes search data from KV Store
        - _deleteSearch() : Deletes the current search from savedsearches.conf and the KV Store
        - _editSS() : Allows for editing all parameters of a saved search 
        - _reloadSearches() : Reloads the saved_searches object that contains all saved searches 
        - _rename() : Allows for renaming of a search 
        - _updateKVstore() : Updates the KV store 


    * Please see individual methods for any specific requirements for passing data or usage.

    To use, a user will need to type:
    var test_var = New SavedSearchManager("saved search name")
    
    Endpoint for KV Store for testing:
    https://{splunk URL}/splunk/en-US/splunkd/_raw/servicesNS/nobody/{app}/storage/collections/data/{kv store name}/{_key value}
*/


class savedSearchManager{
    constructor(search_name) {
        this.mvc = require("splunkjs/mvc");
        this.service = this.mvc.createService({ owner: "nobody", app: "**App Name**", sharing: "global"});
        this.saved_searches = this.service.savedSearches({ app: "**APP NAME**", sharing: "global"});
        this.saved_searches.fetch();
        this.search_name = search_name;
    }

    // setters and getters
    get saved_search() {
        return this.saved_searches.item(this.search_name) || false;
    }

    // returns properties as an object. ex. variableWhatever.ss_props;
    get ss_props() {
        if (this.saved_search === false) {
            var ss_properties = {};
            ss_properties.feedback = this.search_name + " does not exist in savedsearches.conf. \nFields containing values represent play data stored in the KV store.";
            ss_properties.play_name = this.search_name;
        }
        else {
            var ss_properties = this.saved_search.properties();
            delete ss_properties["embed.enabled"];
            delete ss_properties["schedule_priority"];
            delete ss_properties["triggered_alert_count"];
        }
        return ss_properties;
    }

    //Returns an object of read and write permission arrays
    get ss_perms() {
        if (this.saved_search === false) {
            return;
        }
        else {
            return this.saved_search.acl().perms;
        }
    }

    //
    // High Level Methods (Methods to be called in the dashboard)
    //
    
    // Changes current search to a new search
    changePlay(play_name) {
        return this.search_name = play_name;
    }

    // Needs to be passed boolean true for "enable" or false for "disable"
    changeState(option) {
        try {
            if(option) {
                this._editSS({ disabled: false});
                return true;
            }
            else if (!option) {
                this._editSS({ disabled: true});
                return true;
            }
            else {
                return false;
            }
        }
        catch (err) {
            return err;
        }
    }

    // Creates a search in savedsearches.conf, verifies it's been created, then creates the search in the kv store.
    async createSearch(properties, kv_store_data, new_perms) {
        let self = this;
        
        try {
            if (!!properties["name"].match(/\/|\\/g) || kv_store_data["pid"] == "") {
                throw new Error("Invalid PID or Play Name.");
            }

            let search_created = await this._createSS(properties);

            if (search_created.name == "Error") {
                throw search_created;
            }

            if (!!search_created) {
                self._updateKVstore(kv_store_data);
                var isReloaded = await self._reloadSearches();
            }

            if (!!isReloaded) {
                this.changePlay(properties.name);
                this._changePerms(new_perms);
                return true;
            }
        }
        catch (err){
            return err;
        }
    }

    //Returns a promise, requires .then on top level 
    async jobHistory() {
        try {
            let data = await this._getHistory();

            if (!!data) {
                data = JSON.parse(data);
                var historyData = data["entry"].map(function(val) {
                    return {name: val.name, published: val.published};
                });

                return historyData;
            }
        }
        catch (err) {
            return err;
        }
    }

    // Retreives and parses a JSON object from the KVStore, returns kv_props to be used to have accessto KV Store data.
    async kv_data() {
        let query = { "query": JSON.stringify({ "play": this.search_name})};
        let response = await this.service.get("stroage/collections/data/{KV STORE NAME}", query);
        if (response !== null || response !== response) {
            this.kv_props = JSON.parse(response)[0];
            return this.kv_props;
        }
    }

    // Forces a search to run and creates a job 
    async forceRun() {
        var runJob = await this.saved_search.dispatch({force_dispatch: true, trigger_actions: true}, function(err) {
            if (err) {
                return err;
            }
        });

        if (!!runJob) {
            return runJob;
        }
    }

    // First checks if perms are different, if so it updates the,
    // Then checks if name needs to be changed 
    async updateSearch(properties, kv_data, new_perms) {
        let didRun = 0;

        let comparable_perms = {};
        comparable_perms.read = new_perms["perms.read"];
        comparable_perms.write = new_perms["perms.write"];

        let perms = {};
        perms.read = this.ss_perms["read"][0];
        perms.write = this.ss_perms["write"][0];

        // Checks if permissions change is requested
        if (JSON.stringify(comparable_perms) !== JSON.stringify(perms)) {
            try {
                await this._changePerms(new_perms);
                didRun = 1;
            }
            catch (err) {
                return err;
            }
        }

        // Checks if a rename has been requested
        if (properties.name !== this.search_name) {
            try {
                if (!!properties["name"].match(/\/|\\/g)) {
                    throw new Error("Invalid character in play name");
                }
                
                var rename = await this._rename(properties, kv_data);

                if (!!rename) {
                    didRun = 1;
                }
            }
            catch (err) {
                return err;
            }
        }

        let reload = await this._reloadSearches();
        delete properties.name;

        // Verifies a reload first before checking if an updated is requested 
        if (!!reload) {
            if (JSON.stringify(properties) !== JSON.stringify(this.ss_props)){
                try {
                    var updated = await this._editSS(properties);

                    if (!!updated) {
                        this._updateKVstore(kv_data);
                        didRun = 1;
                    }
                }
                catch (err) {
                    return err;
                }
            }
        }
        
        // Checks if one of the functions ran to display user feedback
        if (didRun === 1) {
            return true;
        }
        else {
            return false;
        }
    }

    //
    // Pure Methods (Methods to be used by the higher level methods)
    //

    async _changePerms(new_perms) {
        /* Expects a object
        ex.
        let perms = {
            owner = "admin",
            sharing: "global",
            "perms.read": ["*", "admin"].toString(),
            "perms.write": ["*", "admin"].toString(),
        }
        */

        var permsChanged = await this.service.post(this.saved_search.path().concat("/acl"), new_perms);

        // Checks to verify promise is finished
        if(!!permsChanged) {
            this._reloadSearches();
            return permsChanged;
        }
    }

    // Created a new search, must be passed at minimum: {name: "search Name", search: "search query"}
    // More properties can be passed for creation if desired, in an object.
    async _createSS(properties) {
        try {
            var new_search = await this.saved_search.create(properties, function (err) {
                if (err) {
                    return err;
                }
            });  
        }
        catch (err) {
            return err;
        }

        if (!!new_search) {
            return new_search;
        }
    }

    // Needs to be passed an object containing key:value pair to delete that KV Object
    // It is not ss.conf dependent 
    // Deletes the KV object using the _key value, ***MUST CONTAIN _KEY***
    _deleteKVStore(kv_data) {
        let key = kv_data || false;

        if (!!key) {
            let endpoint = "/" + kv_data._key;

            kv_data = {};

            this.service.request(
                "storage/collections/data/{kv store name}" + endpoint,
                "DELETE",
                null,
                null,
                JSON.stringify(),
                { "Content-Type": "application/json" },
                function (err) {
                    if (err) {
                        return err;
                    }
                    else {
                        return true;
                    }
                });
        }
    }

    // Deletes the current search from savedsearches.conf AND the KV Store 
    async _deleteSearch(search_name, kv_data) {
        let deletedSearchName = search_name || this.search_name;
        let self = this;

        var searchDeleted = await this.saved_searches.del(deletedSearchName, null, function (err) {
            if (err) {
                return err;
            }
            else {
                self._deleteKVStore(kv_store);
            }
        });

        // Checks to verifiy promise is finished 
        if (!!searchDeleted) {
            return true;
        }
    }

    // Updates search properties, pass to this function in JOSN format: {search: "seach string", etc.}
    async _editSS(properties) {
        if (properties) {
            let updateSearch = await this.saved_search.update(properties, function (err) {
                if (err) {
                    return err;
                }
            });

            if (!!updateSearch) {
                return updateSearch;
            }
        }
    }

    // Pulls job history for each saved search 
    async _getHistory() {
        try {
            let histData = await this.service.request(
                "saved/searches/"+this.search_name+"/history",
                "GET",
                null,
                null,
                null,
                { "Content-Type": "application/json" },
                function (err) {
                    if (err) {
                        return err;
                    }
                });

            if (!!histData) {
                return histData;
            }
        }
        catch {
            return err;
        }
    }

    // By default it is fetching all saved_searches 
    async _reloadSearches() {
        let reload = await this.saved_searches.fetch(null, function (err) {
            if (err) {
                return err;
            }
        });

        if (!!reload) {
            return reload;
        }
    }

    // Clones search with the new name and then deletes the old search.
    // kv_data needs to contain all data to be loaded to the KV Store including the _key value of the search being renamed.
    async _rename(properties, kv_data) {
        let new_search = await this._createSS(properties);

        if (!!new_search) {
            this._deleteSearch(this.search_name);
            this._updateKVstore(kv_store);
            this.search_name = properties.name;
            return true;
        }
        else {
            return false;
        }
    }

    // Needs to be passed an object containing a key:value pair tp update the KV Store
    // It is not saved search dependent
    // Upon update, all feilds that are not included are wiped.
    _updateKVstore(kv_data) {
        let endpoint = (!!kv_data._key) ? "/" + kv_data._key : "";

        this.service.request(
            "storage/collections/data/{kv store name}" + endpoint,
            "POST",
            null,
            null,
            JSON.stringify(kv_store),
            { "Content-Type": "application/json" },
            function (err) {
                if (err) {
                    return err;
                }
                else {
                    return true;
                }
            });
    }
}